import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function encryptToken(token: string, secretKeyHex: string, aadContext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const keyBytes = new Uint8Array(secretKeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

  const encryptedBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(aadContext),
      tagLength: 128,
    },
    cryptoKey,
    new TextEncoder().encode(token)
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const data = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);

  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: btoa(String.fromCharCode(...iv)),
    tag: btoa(String.fromCharCode(...tag)),
    data: btoa(String.fromCharCode(...data)),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const mpClientId = Deno.env.get("MP_CLIENT_ID") ?? "";
    const mpClientSecret = Deno.env.get("MP_CLIENT_SECRET") ?? "";
    const mpRedirectUri = Deno.env.get("MP_REDIRECT_URI") ?? "";
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";

    const { code, state } = await req.json();
    if (!code || !state) {
      return new Response(JSON.stringify({ error: { code: "invalid_parameters" } }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const stateHash = await sha256Hex(state);

    // Validate attempt
    const { data: attempt, error: attemptErr } = await supabaseAdmin
      .from("mp_oauth_attempts")
      .select("*")
      .eq("state_hash", stateHash)
      .single();

    if (attemptErr || !attempt || new Date(attempt.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: { code: "oauth_state_invalid_or_expired" } }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Exchange code for token with test_token: true (Homologação)
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: mpClientId,
        client_secret: mpClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: mpRedirectUri,
        code_verifier: attempt.sealed_verifier,
        test_token: true,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.live_mode !== false || !tokenData.access_token.startsWith("TEST-")) {
      return new Response(JSON.stringify({ error: { code: "mp_invalid_oauth_response" } }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const merchantId = attempt.merchant_id;
    const sellerId = String(tokenData.user_id);
    const aadContext = `mp:oauth:${merchantId}:${sellerId}`;

    const encryptedAccessToken = await encryptToken(tokenData.access_token, encryptionKey, aadContext);
    const encryptedRefreshToken = await encryptToken(tokenData.refresh_token, encryptionKey, aadContext);

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 15552000) * 1000).toISOString();

    // Store encrypted connection
    await supabaseAdmin.from("mp_oauth_connections").upsert({
      merchant_id: merchantId,
      seller_id: sellerId,
      encrypted_access_token: encryptedAccessToken,
      encrypted_refresh_token: encryptedRefreshToken,
      public_key: tokenData.public_key,
      token_type: "Bearer",
      expires_at: expiresAt,
      scope: tokenData.scope || "offline_access",
      status: "active",
      updated_at: new Date().toISOString(),
    });

    // Clean up attempt
    await supabaseAdmin.from("mp_oauth_attempts").delete().eq("state_hash", stateHash);

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
    return new Response(JSON.stringify({ error: { code: "internal_error", message: err.message } }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
