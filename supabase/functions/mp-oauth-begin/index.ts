import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sha256Hex, base64UrlSha256, randomBase64Url, encryptAesGcm } from "../_shared/crypto.ts";

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
    const mpRedirectUri = Deno.env.get("MP_REDIRECT_URI") ?? "";
    const encryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !mpClientId || !mpRedirectUri || !encryptionKey) {
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

    // Derive merchant strictly from authenticated user
    const { data: merchant, error: merchantError } = await supabaseAdmin
      .from("merchants")
      .select("id")
      .eq("auth_user_id", user.id)
      .single();

    if (merchantError || !merchant) {
      return new Response(JSON.stringify({ error: { code: "merchant_not_found", message: "No merchant record found" } }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const state = randomBase64Url(32);
    const verifier = randomBase64Url(48);
    const codeChallenge = await base64UrlSha256(verifier);
    const stateHash = await sha256Hex(state);
    const sessionHash = await sha256Hex(user.id);

    // Criptografa o verificador PKCE com AAD vinculado ao lojista e ao stateHash
    const aadContext = `mp:pkce:${merchant.id}:${stateHash}`;
    const encryptedVerifier = await encryptAesGcm(verifier, encryptionKey, aadContext);

    // Salva tentativa (expira em 10 minutos)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabaseAdmin.from("mp_oauth_attempts").insert({
      state_hash: stateHash,
      merchant_id: merchant.id,
      session_hash: sessionHash,
      code_challenge: codeChallenge,
      encrypted_verifier: encryptedVerifier,
      expires_at: expiresAt,
    });

    if (insertError) {
      return new Response(JSON.stringify({ error: { code: "database_error", message: "Failed to persist oauth attempt" } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authUrl = new URL("https://auth.mercadopago.com/authorization");
    authUrl.searchParams.set("client_id", mpClientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("platform_id", "mp");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("redirect_uri", mpRedirectUri);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("code_challenge", codeChallenge);

    return new Response(JSON.stringify({ authorizationUrl: authUrl.toString() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { code: "internal_error", message: "An unexpected error occurred" } }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
