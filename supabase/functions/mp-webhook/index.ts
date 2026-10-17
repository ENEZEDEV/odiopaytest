import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hmacSha256Hex, timingSafeEqual, decryptAesGcm } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const webhookSecret = Deno.env.get("MP_WEBHOOK_SECRET") ?? "";
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !webhookSecret || !encryptionKey) {
      return new Response(JSON.stringify({ error: { code: "configuration_error", message: "Server misconfigured" } }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const xSignature = req.headers.get("x-signature") || "";
    const xRequestId = req.headers.get("x-request-id") || "";

    const body = await req.json();
    const dataId = String(body?.data?.id || body?.id || "");

    if (!dataId) {
      return new Response(JSON.stringify({ received: true, ignored: true, reason: "missing_resource_id" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // 1. Verificação oficial da assinatura do webhook Mercado Pago
    // Formato: ts=1700000000,v1=abcdef...
    const sigParts = Object.fromEntries(
      xSignature.split(",").map((p) => {
        const [k, ...v] = p.trim().split("=");
        return [k, v.join("=")];
      })
    );

    const ts = sigParts.ts || "";
    const v1 = sigParts.v1 || "";

    if (!ts || !v1 || !xRequestId) {
      return new Response(JSON.stringify({ error: { code: "invalid_signature", message: "Missing signature headers" } }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const computedHmac = await hmacSha256Hex(webhookSecret, manifest);

    if (!timingSafeEqual(computedHmac, v1)) {
      return new Response(JSON.stringify({ error: { code: "invalid_signature", message: "Signature verification failed" } }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const eventId = String(body.id || `${xRequestId}:${dataId}`);
    const topic = String(body.action || body.type || "payment");

    // 2. Persistência durável, deduplicação e recuperação de eventos incompletos
    let isRetry = false;
    const { error: insertError } = await supabaseAdmin
      .from("webhook_events")
      .insert({
        event_id: eventId,
        resource_id: dataId,
        topic,
        signature: xSignature,
        payload: body,
        status: "received",
      });

    if (insertError) {
      if (insertError.code === "23505") {
        // Evento já existe no banco: verificar status anterior
        const { data: existingEvent, error: fetchErr } = await supabaseAdmin
          .from("webhook_events")
          .select("id, status, payload")
          .eq("event_id", eventId)
          .single();

        if (fetchErr || !existingEvent) {
          return new Response(JSON.stringify({ error: { code: "database_error", message: "Failed to read existing webhook" } }), {
            status: 500,
            headers: corsHeaders,
          });
        }

        // Se já foi processado com sucesso ('processed') e não é nova ação, deduplica sem reprocessar
        if (existingEvent.status === "processed" && topic !== "payment.updated") {
          return new Response(JSON.stringify({ received: true, status: "already_processed" }), {
            status: 200,
            headers: corsHeaders,
          });
        }

        // Se o evento anterior estava incompleto ('received' ou 'failed') ou é atualização de status,
        // permite reprocessamento e recupera o fluxo
        isRetry = true;
        await supabaseAdmin
          .from("webhook_events")
          .update({
            status: "received",
            signature: xSignature,
            payload: body,
          })
          .eq("event_id", eventId);
      } else {
        return new Response(JSON.stringify({ error: { code: "database_error", message: "Failed to persist webhook event" } }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // 3. Consulta da intenção no banco
    const { data: intent, error: intentError } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("mp_payment_id", dataId)
      .maybeSingle();

    if (intentError || !intent) {
      return new Response(JSON.stringify({ received: true, status: "intent_not_found" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // 4. Recupera e decifra o token OAuth do vendedor
    const { data: oauthConn } = await supabaseAdmin
      .from("mp_oauth_connections")
      .select("*")
      .eq("merchant_id", intent.merchant_id)
      .eq("status", "active")
      .single();

    if (!oauthConn) {
      await supabaseAdmin.from("webhook_events").update({ status: "failed" }).eq("event_id", eventId);
      return new Response(JSON.stringify({ received: true, status: "oauth_connection_missing" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const aadContext = `mp:oauth:${intent.merchant_id}:${oauthConn.seller_id}`;
    const sellerAccessToken = await decryptAesGcm(oauthConn.encrypted_access_token, encryptionKey, aadContext);

    // 5. Consulta autoritativa à API do Mercado Pago
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${sellerAccessToken}` },
    });

    if (!mpRes.ok) {
      await supabaseAdmin.from("webhook_events").update({ status: "failed" }).eq("event_id", eventId);
      return new Response(JSON.stringify({ received: true, status: "upstream_fetch_error" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    const mpPayment = await mpRes.json();

    // 6. Validação estrita dos dados do pagamento
    const decimalAmount = (intent.amount_cents / 100).toFixed(2);
    if (
      mpPayment.live_mode !== false ||
      String(mpPayment.collector_id) !== String(oauthConn.seller_id) ||
      mpPayment.currency_id !== "BRL" ||
      Number(mpPayment.transaction_amount) !== Number(decimalAmount) ||
      mpPayment.external_reference !== intent.id
    ) {
      await supabaseAdmin.from("webhook_events").update({ status: "failed" }).eq("event_id", eventId);
      return new Response(JSON.stringify({ received: true, status: "validation_mismatch" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // 7. Atualização transacional de estado e tratamento de alterações posteriores à aprovação
    if (mpPayment.status === "approved") {
      if (intent.status === "succeeded") {
        // Já aprovado anteriormente; confirmação idempotente
        await supabaseAdmin
          .from("webhook_events")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("event_id", eventId);

        return new Response(
          JSON.stringify({ received: true, status: "already_succeeded", intentId: intent.id, isRetry }),
          { status: 200, headers: corsHeaders }
        );
      }

      await supabaseAdmin.rpc("settle_payment_transaction", {
        p_intent_id: intent.id,
        p_mp_payment_id: String(dataId),
        p_status_detail: mpPayment.status_detail || "accredited",
      });
    } else if (mpPayment.status === "refunded" || mpPayment.status === "charged_back") {
      // Alteração posterior à aprovação: estorno ou disputa
      await supabaseAdmin.rpc("handle_payment_reversal", {
        p_intent_id: intent.id,
        p_new_status: mpPayment.status,
        p_status_detail: mpPayment.status_detail || "reversed",
      });
    } else if (mpPayment.status === "rejected" || mpPayment.status === "cancelled") {
      if (intent.status !== "succeeded" && intent.status !== "refunded" && intent.status !== "charged_back") {
        await supabaseAdmin
          .from("payment_intents")
          .update({
            status: mpPayment.status === "cancelled" ? "cancelled" : "failed",
            mp_status: mpPayment.status,
            mp_status_detail: mpPayment.status_detail,
            updated_at: new Date().toISOString(),
          })
          .eq("id", intent.id);
      }
    }

    // Marca evento como processado com sucesso
    await supabaseAdmin.from("webhook_events").update({
      status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("event_id", eventId);

    return new Response(
      JSON.stringify({ received: true, status: "processed", intentId: intent.id, isRetry, paymentStatus: mpPayment.status }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { code: "webhook_error", message: err.message } }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
