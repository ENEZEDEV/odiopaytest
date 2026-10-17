import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sha256Hex, encryptAesGcm, decryptAesGcm } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const mpClientId = Deno.env.get("MP_CLIENT_ID") ?? "";
    const mpClientSecret = Deno.env.get("MP_CLIENT_SECRET") ?? "";
    const mpRedirectUri = Deno.env.get("MP_REDIRECT_URI") ?? "";
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !mpClientId || !mpClientSecret || !mpRedirectUri || !encryptionKey) {
      return new Response(JSON.stringify({ error: { code: "configuration_error", message: "Server misconfigured" } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Authorization bearer token required" } }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Invalid session" } }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { code, state } = await req.json();
    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
      return new Response(JSON.stringify({ error: { code: "invalid_parameters", message: "Code and state are required" } }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stateHash = await sha256Hex(state);
    const sessionHash = await sha256Hex(user.id);

    // Consumo atômico da tentativa vinculada à sessão do lojista
    const { data: attempts, error: rpcError } = await supabaseAdmin.rpc("consume_oauth_attempt", {
      p_state_hash: stateHash,
      p_session_hash: sessionHash,
    });

    if (rpcError || !attempts || attempts.length === 0) {
      return new Response(JSON.stringify({ error: { code: "oauth_state_invalid_or_expired", message: "State is invalid, expired, or already used" } }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const attempt = attempts[0];

    // Decifra o PKCE code_verifier usando a chave do backend e AAD
    const pkceAad = `mp:pkce:${attempt.merchant_id}:${stateHash}`;
    let codeVerifier = "";
    try {
      codeVerifier = await decryptAesGcm(attempt.encrypted_verifier, encryptionKey, pkceAad);
    } catch {
      return new Response(JSON.stringify({ error: { code: "decryption_error", message: "Failed to decrypt PKCE verifier" } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Troca o authorization code por tokens com test_token: true (Homologação)
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: mpClientId,
        client_secret: mpClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: mpRedirectUri,
        code_verifier: codeVerifier,
        test_token: true,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.live_mode !== false || !tokenData.access_token || !tokenData.access_token.startsWith("TEST-")) {
      return new Response(JSON.stringify({ error: { code: "mp_invalid_oauth_response", message: "Mercado Pago rejected oauth exchange or returned non-test credentials" } }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const merchantId = attempt.merchant_id;
    const sellerId = String(tokenData.user_id);
    const aadContext = `mp:oauth:${merchantId}:${sellerId}`;

    const encryptedAccessToken = await encryptAesGcm(tokenData.access_token, encryptionKey, aadContext);
    const encryptedRefreshToken = await encryptAesGcm(tokenData.refresh_token, encryptionKey, aadContext);

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 15552000) * 1000).toISOString();

    // Salva a conexão garantindo que callbacks defasados não sobrescrevam conexões mais novas
    const { data: saved, error: saveError } = await supabaseAdmin.rpc("save_oauth_connection", {
      p_merchant_id: merchantId,
      p_seller_id: sellerId,
      p_encrypted_access_token: encryptedAccessToken,
      p_encrypted_refresh_token: encryptedRefreshToken,
      p_public_key: tokenData.public_key,
      p_token_type: "Bearer",
      p_expires_at: expiresAt,
      p_scope: tokenData.scope || "offline_access",
      p_attempt_created_at: attempt.created_at,
    });

    if (saveError) {
      return new Response(JSON.stringify({ error: { code: "database_error", message: "Failed to persist oauth connection" } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!saved) {
      return new Response(JSON.stringify({ error: { code: "oauth_connection_outdated", message: "A newer connection already exists; ignoring outdated callback" } }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        connected: true,
        sellerId,
        publicKey: tokenData.public_key,
        environment: "sandbox",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { code: "internal_error", message: "An unexpected error occurred" } }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
