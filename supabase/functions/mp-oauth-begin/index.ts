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

async function base64UrlSha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const mpClientId = Deno.env.get("MP_CLIENT_ID") ?? "";
    const mpRedirectUri = Deno.env.get("MP_REDIRECT_URI") ?? "";

    if (!supabaseUrl || !supabaseServiceKey || !mpClientId || !mpRedirectUri) {
      return new Response(JSON.stringify({ error: { code: "configuration_error" } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
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
      return new Response(JSON.stringify({ error: { code: "merchant_not_found" } }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const state = randomBase64Url(32);
    const verifier = randomBase64Url(48);
    const codeChallenge = await base64UrlSha256(verifier);
    const stateHash = await sha256Hex(state);
    const sessionHash = await sha256Hex(user.id);

    // Save attempt (valid for 10 minutes)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabaseAdmin.from("mp_oauth_attempts").upsert({
      state_hash: stateHash,
      merchant_id: merchant.id,
      session_hash: sessionHash,
      code_challenge: codeChallenge,
      sealed_verifier: verifier, // Em produção, cifrar com TokenVault
      expires_at: expiresAt,
    });

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
    return new Response(JSON.stringify({ error: { code: "internal_error", message: err.message } }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
