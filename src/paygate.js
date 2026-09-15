/**
 * MAP — PAYGATE: verify a Stripe Checkout Session was paid before releasing the code.
 * Uses STRIPE_SECRET_KEY (restricted key, Checkout Sessions: read). No Stripe SDK — plain fetch.
 * Recovers the customer's website URL that the page carried through checkout.
 * ADDITIVE. Runs server-side (Vercel function / backend). Never in the browser.
 */

const CLEAN = (s) => (typeof s === "string" && s.trim() ? s.trim() : null);

// The page carries the customer's URL through checkout as base64url in client_reference_id
// (keeps URL characters out of Stripe's reference field). Decode it back here.
function b64urlDecode(s) {
  try {
    const b = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
    return Buffer.from(b + pad, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function verifyPaidSession(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  if (!CLEAN(sessionId)) return { paid: false, reason: "no session id" };

  const res = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId),
    { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) }
  );
  if (res.status === 404) return { paid: false, reason: "session not found" };
  if (!res.ok) return { paid: false, reason: "stripe http " + res.status };

  const s = await res.json();
  const paid = s.payment_status === "paid" || s.status === "complete";

  // Recover the customer's URL: client_reference_id (base64url) first, else a custom field.
  let url = s.client_reference_id ? b64urlDecode(s.client_reference_id) : null;
  if (!url && Array.isArray(s.custom_fields)) {
    const f = s.custom_fields.find((x) => /url|website|site/i.test(x && x.key || ""));
    if (f && f.text && f.text.value) url = f.text.value;
  }

  return { paid, url: CLEAN(url), amount: s.amount_total, currency: s.currency, sessionId };
}

export { verifyPaidSession, b64urlDecode };
