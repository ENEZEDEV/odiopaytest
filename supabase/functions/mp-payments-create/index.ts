import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TARIFFS: Record<string, Record<string, { bps: number; fixedCents: number }>> = {
  standard: {
    pix: { bps: 0, fixedCents: 100 },
    card: { bps: 399, fixedCents: 39 },
  },
  pro: {
    pix: { bps: 0, fixedCents: 50 },
    card: { bps: 299, fixedCents: 30 },
  },
};

function calculateServerFee(amountCents: number, method: string, plan: string): number {
  const tariff = TARIFFS[plan] || TARIFFS.standard;
  const rule = tariff[method];
  if (!rule) throw new Error("invalid_payment_method");
  const proportional = (BigInt(amountCents) * BigInt(rule.bps) + 9999n) / 10000n;
  const fee = Number(proportional) + rule.fixedCents;
  return Math.min(amountCents, fee);
}

// AES-GCM Decryption of encrypted OAuth token envelope
async function decryptToken(envelopeJson: string, secretKeyHex: string, aadContext: string): Promise<string> {
  const envelope = JSON.parse(envelopeJson);
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const tag = Uint8Array.from(atob(envelope.tag), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(envelope.data), (c) => c.charCodeAt(0));

  const keyBytes = new Uint8Array(secretKeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);

  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);

  const decryptedBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(aadContext),
      tagLength: 128,
    },
    cryptoKey,
    combined
  );

  const decryptedText = new TextDecoder().decode(decryptedBuf);
  try {
    const parsed = JSON.parse(decryptedText);
    return typeof parsed === "string" ? parsed : parsed.accessToken || decryptedText;
  } catch {
    return decryptedText;
  }
}

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

    // 1. Derive merchant strictly from authenticated user identity
    const { data: merchant, error: merchantError } = await supabaseAdmin
      .from("merchants")
      .select("id, name, plan")
      .eq("auth_user_id", user.id)
      .single();

    if (merchantError || !merchant) {
      return new Response(
        JSON.stringify({ error: { code: "merchant_not_found", message: "Merchant profile not registered for user" } }),
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

    // 2. Strict Input Validation
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

    // 3. Server-side fee calculation (Client fee values are discarded)
    const feeCents = calculateServerFee(amountCents, method, merchant.plan);

    // Compute request digest for idempotency conflict detection
    const digestData = JSON.stringify({
      merchantId: merchant.id,
      amountCents,
      feeCents,
      method,
      payerEmail,
      cardToken: method === "card" ? cardToken : null,
      paymentMethodId: method === "card" ? paymentMethodId : null,
    });
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestData));
    const requestDigest = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

    // 4. Idempotency Check
    const { data: existingIntent } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("merchant_id", merchant.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingIntent) {
      if (existingIntent.request_digest !== requestDigest) {
        return new Response(
          JSON.stringify({ error: { code: "idempotency_conflict", message: "Key already used with different parameters" } }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Replay sanitized cached response
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

    // 5. Retrieve and Decrypt OAuth credentials of the merchant
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
      sellerAccessToken = await decryptToken(oauthConn.encrypted_access_token, encryptionKey, aadContext);
    } catch {
      return new Response(
        JSON.stringify({ error: { code: "credentials_decryption_error", message: "Failed to decrypt credentials" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Homologation check
    if (!sellerAccessToken.startsWith("TEST-")) {
      return new Response(
        JSON.stringify({ error: { code: "mp_test_credentials_required", message: "Production credentials blocked in homologation" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Record persistent intent in DB
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
      return new Response(
        JSON.stringify({ error: { code: "database_error", message: "Failed to persist payment intent" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Call Mercado Pago Payments API with application_fee
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
      // Reconcile on network timeout / abort
      const searchRes = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${newIntent.id}`, {
        headers: { Authorization: `Bearer ${sellerAccessToken}` },
      }).catch(() => null);

      if (searchRes && searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.results && searchData.results.length > 0) {
          const found = searchData.results[0];
          await supabaseAdmin
            .from("payment_intents")
            .update({
              status: found.status === "approved" ? "succeeded" : "requires_action",
              mp_payment_id: String(found.id),
              mp_status: found.status,
              mp_status_detail: found.status_detail,
            })
            .eq("id", newIntent.id);

          return new Response(
            JSON.stringify({
              payment: {
                id: newIntent.id,
                amountCents,
                feeCents,
                netCents: amountCents - feeCents,
                currency: "BRL",
                method,
                status: found.status === "approved" ? "succeeded" : "requires_action",
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

      await supabaseAdmin
        .from("payment_intents")
        .update({ status: "requires_reconciliation", error_code: "network_timeout" })
        .eq("id", newIntent.id);

      return new Response(
        JSON.stringify({ error: { code: "gateway_timeout", message: "Upstream gateway timed out; marked for reconciliation" } }),
        { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mpData = await mpResponse.json();

    if (mpData.live_mode !== false) {
      await supabaseAdmin.from("payment_intents").update({ status: "failed", error_code: "production_blocked" }).eq("id", newIntent.id);
      return new Response(
        JSON.stringify({ error: { code: "mp_production_blocked", message: "Production mode is prohibited in sandbox" } }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isApproved = mpData.status === "approved";
    const status = isApproved ? "succeeded" : (mpData.status === "rejected" ? "failed" : "requires_action");

    // Update intent
    await supabaseAdmin
      .from("payment_intents")
      .update({
        status,
        mp_payment_id: String(mpData.id),
        mp_status: mpData.status,
        mp_status_detail: mpData.status_detail,
        qr_code: mpData.point_of_interaction?.transaction_data?.qr_code ?? null,
        qr_code_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64 ?? null,
        ticket_url: mpData.point_of_interaction?.transaction_data?.ticket_url ?? null,
      })
      .eq("id", newIntent.id);

    // Sanitized output DTO
    return new Response(
      JSON.stringify({
        payment: {
          id: newIntent.id,
          amountCents,
          feeCents,
          netCents: amountCents - feeCents,
          currency: "BRL",
          method,
          status,
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
      JSON.stringify({ error: { code: "internal_error", message: err.message || "An unexpected error occurred" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
