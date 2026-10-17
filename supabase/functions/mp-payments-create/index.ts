import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sha256Hex, decryptAesGcm } from "../_shared/crypto.ts";
import { calculateServerFee } from "../_shared/tariffs.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !encryptionKey) {
      return new Response(
        JSON.stringify({ error: { code: "server_misconfiguration", message: "Missing backend configuration" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "Bearer token required" } }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "Invalid or expired session" } }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Identidade do lojista derivada estritamente de auth.uid()
    const { data: merchant, error: merchantError } = await supabaseAdmin
      .from("merchants")
      .select("id, name, plan")
      .eq("auth_user_id", user.id)
      .single();

    if (merchantError || !merchant) {
      return new Response(
        JSON.stringify({ error: { code: "merchant_not_found", message: "Merchant profile not registered" } }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const idempotencyKey = req.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return new Response(
        JSON.stringify({ error: { code: "invalid_idempotency_key", message: "Header idempotency-key (8-128 chars) required" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { amountCents, method, payerEmail, cardToken, paymentMethodId } = body;

    // 2. Validação estrita de entrada
    if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 100000000) {
      return new Response(
        JSON.stringify({ error: { code: "invalid_amount", message: "Amount must be between 100 and 100,000,000 cents" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!["pix", "card"].includes(method)) {
      return new Response(
        JSON.stringify({ error: { code: "invalid_method", message: "Payment method must be pix or card" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (typeof payerEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail) || payerEmail.length > 254) {
      return new Response(
        JSON.stringify({ error: { code: "invalid_payer_email", message: "Valid payer email is required" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Cálculo de tarifas estritamente no servidor (qualquer tarifa vinda do cliente é desconsiderada)
    const feeCents = calculateServerFee(amountCents, method, merchant.plan);

    // Digest da requisição para verificar integridade da idempotência
    const digestData = JSON.stringify({
      merchantId: merchant.id,
      amountCents,
      feeCents,
      method,
      payerEmail,
      cardToken: method === "card" ? cardToken : null,
      paymentMethodId: method === "card" ? paymentMethodId : null,
    });
    const requestDigest = await sha256Hex(digestData);

    // 4. Conexão OAuth do lojista vendedor
    const { data: oauthConn, error: oauthError } = await supabaseAdmin
      .from("mp_oauth_connections")
      .select("*")
      .eq("merchant_id", merchant.id)
      .eq("status", "active")
      .single();

    if (oauthError || !oauthConn) {
      return new Response(
        JSON.stringify({ error: { code: "oauth_connection_required", message: "Merchant must connect Mercado Pago via OAuth" } }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aadContext = `mp:oauth:${merchant.id}:${oauthConn.seller_id}`;
    let sellerAccessToken = "";
    try {
      sellerAccessToken = await decryptAesGcm(oauthConn.encrypted_access_token, encryptionKey, aadContext);
    } catch {
      return new Response(
        JSON.stringify({ error: { code: "credentials_decryption_error", message: "Failed to decrypt seller credentials" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!sellerAccessToken.startsWith("TEST-")) {
      return new Response(
        JSON.stringify({ error: { code: "mp_test_credentials_required", message: "Production credentials prohibited in homologation" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Verificação de Idempotência no Banco
    const { data: existingIntent } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("merchant_id", merchant.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingIntent) {
      if (existingIntent.request_digest !== requestDigest) {
        return new Response(
          JSON.stringify({ error: { code: "idempotency_conflict", message: "Idempotency key already used with different parameters" } }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (existingIntent.status === "processing") {
        return new Response(
          JSON.stringify({ error: { code: "payment_in_progress", message: "Payment is currently processing" } }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Reconciliação caso tenha ficado pendente após timeout anterior
      if (existingIntent.status === "requires_reconciliation") {
        const searchRes = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${existingIntent.id}`, {
          headers: { Authorization: `Bearer ${sellerAccessToken}` },
        }).catch(() => null);

        if (searchRes && searchRes.ok) {
          const searchData = await searchRes.json();
          const match = searchData.results?.find((p: any) =>
            p.live_mode === false &&
            String(p.collector_id) === String(oauthConn.seller_id) &&
            p.currency_id === "BRL" &&
            Number(p.transaction_amount) === Number((existingIntent.amount_cents / 100).toFixed(2)) &&
            p.external_reference === existingIntent.id
          );

          if (match) {
            if (match.status === "approved") {
              await supabaseAdmin.rpc("settle_payment_transaction", {
                p_intent_id: existingIntent.id,
                p_mp_payment_id: String(match.id),
                p_status_detail: match.status_detail || "accredited",
              });
              existingIntent.status = "succeeded";
              existingIntent.mp_payment_id = String(match.id);
            }
          }
        }

        // Se ainda não foi encontrado na conciliação, NÃO cria cobrança duplicada! Mantém pendente.
        if (existingIntent.status === "requires_reconciliation") {
          return new Response(
            JSON.stringify({ error: { code: "gateway_timeout", message: "Payment is pending reconciliation" } }),
            { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      // Replay seguro e sanitizado da resposta anterior
      return new Response(
        JSON.stringify({
          payment: {
            id: existingIntent.id,
            amountCents: existingIntent.amount_cents,
            feeCents: existingIntent.fee_cents,
            netCents: existingIntent.net_cents,
            currency: "BRL",
            method: existingIntent.method,
            status: existingIntent.status,
            statusDetail: existingIntent.mp_status_detail,
            mpPaymentId: existingIntent.mp_payment_id,
            qrCode: existingIntent.qr_code,
            qrCodeBase64: existingIntent.qr_code_base64,
            ticketUrl: existingIntent.ticket_url,
            createdAt: existingIntent.created_at,
            replayed: true,
            environment: "sandbox",
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Inserção persistente da intenção (status 'processing')
    const { data: newIntent, error: insertError } = await supabaseAdmin
      .from("payment_intents")
      .insert({
        merchant_id: merchant.id,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
        amount_cents: amountCents,
        fee_cents: feeCents,
        currency: "BRL",
        method,
        payer_email: payerEmail,
        status: "processing",
      })
      .select()
      .single();

    if (insertError || !newIntent) {
      if (insertError?.code === "23505") {
        return new Response(
          JSON.stringify({ error: { code: "idempotency_conflict", message: "Concurrent request conflict" } }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "database_error", message: "Failed to persist intent" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Chamada ao Mercado Pago Payments API com split 1:1 via application_fee
    const decimalAmount = (amountCents / 100).toFixed(2);
    const decimalFee = (feeCents / 100).toFixed(2);

    let mpResponse: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      mpResponse = await fetch("https://api.mercadopago.com/v1/payments", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${sellerAccessToken}`,
          "X-Idempotency-Key": `${merchant.id}:${idempotencyKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transaction_amount: Number(decimalAmount),
          application_fee: Number(decimalFee),
          external_reference: newIntent.id,
          description: `ODIOPAY Split ${newIntent.id}`,
          payer: { email: payerEmail },
          payment_method_id: method === "pix" ? "pix" : paymentMethodId,
          ...(method === "card" ? { token: cardToken, installments: 1 } : {}),
        }),
      });
      clearTimeout(timeoutId);
    } catch {
      // Reconciliação imediata após timeout / falha de conexão
      const searchRes = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${newIntent.id}`, {
        headers: { Authorization: `Bearer ${sellerAccessToken}` },
      }).catch(() => null);

      if (searchRes && searchRes.ok) {
        const searchData = await searchRes.json();
        const found = searchData.results?.find((p: any) =>
          p.live_mode === false &&
          String(p.collector_id) === String(oauthConn.seller_id) &&
          p.currency_id === "BRL" &&
          Number(p.transaction_amount) === Number(decimalAmount) &&
          p.external_reference === newIntent.id
        );

        if (found) {
          if (found.status === "approved") {
            await supabaseAdmin.rpc("settle_payment_transaction", {
              p_intent_id: newIntent.id,
              p_mp_payment_id: String(found.id),
              p_status_detail: found.status_detail || "accredited",
            });
            return new Response(
              JSON.stringify({
                payment: {
                  id: newIntent.id,
                  amountCents,
                  feeCents,
                  netCents: amountCents - feeCents,
                  currency: "BRL",
                  method,
                  status: "succeeded",
                  statusDetail: found.status_detail,
                  mpPaymentId: String(found.id),
                  replayed: false,
                  environment: "sandbox",
                },
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          } else {
            await supabaseAdmin.from("payment_intents").update({
              status: found.status === "rejected" ? "failed" : "requires_action",
              mp_payment_id: String(found.id),
              mp_status: found.status,
              mp_status_detail: found.status_detail,
            }).eq("id", newIntent.id);

            return new Response(
              JSON.stringify({
                payment: {
                  id: newIntent.id,
                  amountCents,
                  feeCents,
                  netCents: amountCents - feeCents,
                  currency: "BRL",
                  method,
                  status: found.status === "rejected" ? "failed" : "requires_action",
                  statusDetail: found.status_detail,
                  mpPaymentId: String(found.id),
                  replayed: false,
                  environment: "sandbox",
                },
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      }

      // Se a busca vazia não confirmou cobrança, mantém pendente de reconciliação.
      // Uma busca vazia NÃO autoriza criar outra cobrança!
      await supabaseAdmin
        .from("payment_intents")
        .update({ status: "requires_reconciliation", error_code: "network_timeout" })
        .eq("id", newIntent.id);

      return new Response(
        JSON.stringify({ error: { code: "gateway_timeout", message: "Gateway timed out; intent marked for reconciliation" } }),
        { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mpData = await mpResponse.json();

    // Validação estrita de modo de teste e parâmetros retornados pelo gateway
    if (mpData.live_mode !== false) {
      await supabaseAdmin.from("payment_intents").update({ status: "failed", error_code: "production_blocked" }).eq("id", newIntent.id);
      return new Response(
        JSON.stringify({ error: { code: "mp_production_blocked", message: "Production mode is strictly blocked" } }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (String(mpData.collector_id) !== String(oauthConn.seller_id) ||
        mpData.currency_id !== "BRL" ||
        Number(mpData.transaction_amount) !== Number(decimalAmount) ||
        mpData.external_reference !== newIntent.id) {
      await supabaseAdmin.from("payment_intents").update({ status: "failed", error_code: "gateway_validation_mismatch" }).eq("id", newIntent.id);
      return new Response(
        JSON.stringify({ error: { code: "gateway_validation_mismatch", message: "Gateway response parameters do not match intent" } }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isApproved = mpData.status === "approved";

    if (isApproved) {
      await supabaseAdmin.rpc("settle_payment_transaction", {
        p_intent_id: newIntent.id,
        p_mp_payment_id: String(mpData.id),
        p_status_detail: mpData.status_detail || "accredited",
      });
    } else {
      await supabaseAdmin.from("payment_intents").update({
        status: mpData.status === "rejected" ? "failed" : "requires_action",
        mp_payment_id: String(mpData.id),
        mp_status: mpData.status,
        mp_status_detail: mpData.status_detail,
        qr_code: mpData.point_of_interaction?.transaction_data?.qr_code ?? null,
        qr_code_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
        ticket_url: mpData.point_of_interaction?.transaction_data?.ticket_url ?? null,
      }).eq("id", newIntent.id);
    }

    return new Response(
      JSON.stringify({
        payment: {
          id: newIntent.id,
          amountCents,
          feeCents,
          netCents: amountCents - feeCents,
          currency: "BRL",
          method,
          status: isApproved ? "succeeded" : (mpData.status === "rejected" ? "failed" : "requires_action"),
          statusDetail: mpData.status_detail,
          mpPaymentId: String(mpData.id),
          qrCode: mpData.point_of_interaction?.transaction_data?.qr_code ?? null,
          qrCodeBase64: mpData.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
          ticketUrl: mpData.point_of_interaction?.transaction_data?.ticket_url ?? null,
          createdAt: newIntent.created_at,
          replayed: false,
          environment: "sandbox",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { code: "internal_error", message: "An unexpected error occurred" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
