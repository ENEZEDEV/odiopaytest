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
    // Formato do x-signature: ts=1700000000,v1=abcdef...
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

    // Template oficial de manifest do Mercado Pago:
    // id:[data.id];request-id:[x-request-id];ts:[ts];
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

    // 2. Persistência durável e deduplicação de eventos antes de processar
    const { data: insertedEvent, error: insertError } = await supabaseAdmin
      .from("webhook_events")
      .insert({
        event_id: eventId,
        resource_id: dataId,
        topic,
        signature: xSignature,
        payload: body,
        status: "received",
      })
      .select()
      .maybeSingle();

    if (insertError) {
      if (insertError.code === "23505") {
        // Evento já persistido e deduplicado
        return new Response(JSON.stringify({ received: true, status: "already_processed" }), {
          status: 200,
          headers: corsHeaders,
        });
      }
      return new Response(JSON.stringify({ error: { code: "database_error", message: "Failed to persist webhook event" } }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // 3. Consulta ao banco para localizar a intenção de pagamento
    const { data: intent, error: intentError } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("mp_payment_id", dataId)
      .maybeSingle();

    if (intentError || !intent) {
      // Se a intenção não estiver associada ao mp_payment_id direto, tenta por id se for UUID
      return new Response(JSON.stringify({ received: true, status: "intent_not_found" }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Tratamento de eventos fora de ordem: se já estiver em estado terminal 'succeeded', não re-processa
    if (intent.status === "succeeded") {
      await supabaseAdmin.from("webhook_events").update({ status: "processed", processed_at: new Date().toISOString() }).eq("event_id", eventId);
      return new Response(JSON.stringify({ received: true, status: "already_succeeded", intentId: intent.id }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // 4. Recupera e decifra o token OAuth do vendedor para consultar o Mercado Pago
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

    // 7. Atualização transacional de estado
    if (mpPayment.status === "approved") {
      await supabaseAdmin.rpc("settle_payment_transaction", {
        p_intent_id: intent.id,
        p_mp_payment_id: String(dataId),
        p_status_detail: mpPayment.status_detail || "accredited",
      });
    } else if (mpPayment.status === "rejected") {
      await supabaseAdmin.from("payment_intents").update({
        status: "failed",
        mp_status: mpPayment.status,
        mp_status_detail: mpPayment.status_detail,
      }).eq("id", intent.id);
    }

    await supabaseAdmin.from("webhook_events").update({
      status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("event_id", eventId);

    return new Response(
      JSON.stringify({ received: true, status: "processed", intentId: intent.id }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { code: "webhook_error", message: err.message } }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
