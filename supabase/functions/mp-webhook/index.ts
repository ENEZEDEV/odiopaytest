import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();

    // MP Webhooks format: { action: "payment.updated", data: { id: "12345" } }
    if (!body || !body.data || !body.data.id) {
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: corsHeaders });
    }

    const mpPaymentId = String(body.data.id);

    // Look up payment intent by mp_payment_id
    const { data: intent, error } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("mp_payment_id", mpPaymentId)
      .maybeSingle();

    if (error || !intent) {
      // Payment not registered in this instance or already processed
      return new Response(JSON.stringify({ received: true, ignored: true }), { status: 200, headers: corsHeaders });
    }

    // Do not trust webhook payload directly. Query Mercado Pago with seller's token for authoritative state
    // (In production, decrypt seller's token and call /v1/payments/{id})
    return new Response(JSON.stringify({ received: true, intentId: intent.id }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { code: "webhook_error", message: err.message } }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
