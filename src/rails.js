/**
 * MAP — READ module, v1.1 DRAFT: additional rail detectors.
 *
 * ADDITIVE + UNWIRED. read.js does not import this yet. Nothing in the running
 * server changes until decodeMerchant is hooked (two ~1-line calls, shown at the
 * bottom of this file) — and that hook waits for Lisa's go.
 *
 * Ground-truthed Aug 5 2026 (see memory: reference_agent_commerce_rails):
 *   - MPP  (Stripe/Tempo Machine Payments Protocol) — HTTP 402 + WWW-Authenticate: Payment.
 *     Autonomous family (x402's cousin). CAN earn outcome "autonomous".
 *   - UCP  (Universal Commerce Protocol) — GET /.well-known/ucp. Assistant/human-in-loop.
 *     Enriches a human_checkout read; NEVER autonomous.
 *   - ACP is NOT here on purpose: no merchant-origin signal exists (discovery is
 *     platform-gated). Detecting it would be inference. Dropped, honestly.
 *
 * Same discipline as read.js: verify before declare. False human_checkout is
 * fine; false autonomous is forbidden. Reads only; never signs or pays.
 */

const USER_AGENT =
  "MAP/1.1 (Maraventano Agent Protocol; open-web merchant decoder; reads, never pays)";
const WELL_KNOWN_TIMEOUT_MS = 5000;

// Fiat minor-unit decimals we are SURE of. Only decode a price when we know the
// decimals; anything else stays null (a false price is worse than none).
const FIAT_DECIMALS = { usd: 2, eur: 2, gbp: 2, cad: 2, aud: 2, chf: 2 };

// Known USDC token contracts (mirrors read.js). Used only to LABEL currency as
// "USDC" — NOT to decode a crypto amount (MPP crypto base-unit decimals are
// merchant-configured and unverified; see BUILD-GATE 1).
const USDC_ASSETS = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // Solana
  "0x20c000000000000000000000b9537d11c60e8b50", // Tempo USDC (per Stripe MPP docs)
]);

function round2(n) {
  return Math.round(n * 100) / 100;
}

const PAY_MPP =
  "Agent-payable via MPP (Machine Payments Protocol, Stripe/Tempo). Re-fetch the live 402 " +
  "challenge and authorize with your own credential — an SPT for fiat, or an on-chain payment " +
  "for crypto — see this kit's wallet lessons: read-this-challenge, then how-do-i-pay. " +
  "Merchant Key reads; it never signs or pays.";

// ---------------------------------------------------------------------------
// MPP — HTTP 402 + WWW-Authenticate: Payment  (autonomous family)
// ---------------------------------------------------------------------------

// The `request` param is base64url-encoded JCS JSON carrying {amount,currency,recipient}.
function b64urlJson(s) {
  try {
    const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

// One 402 may carry MULTIPLE `Payment` challenges (e.g. tempo + stripe). Node's
// fetch joins repeated WWW-Authenticate headers with ", ", which collides with the
// comma between params — so we split at each `Payment ` auth-scheme token, then
// parse key="value" / key=value pairs within each challenge.
// BUILD-GATE 2: harden this against a real 2-method 402 from stripe-samples/machine-payments.
function parsePaymentChallenges(wwwAuth) {
  if (!wwwAuth) return [];
  const out = [];
  const chunks = String(wwwAuth)
    .split(/(?=(?:^|,\s*)Payment\s)/i)
    .map((c) => c.replace(/^,\s*/, "").trim())
    .filter((c) => /^Payment\s/i.test(c));
  for (const chunk of chunks) {
    const params = {};
    const re = /(\w+)=("([^"]*)"|[^,\s]+)/g;
    let m;
    while ((m = re.exec(chunk.replace(/^Payment\s+/i, "")))) {
      params[m[1].toLowerCase()] = m[3] != null ? m[3] : m[2];
    }
    if (params.request) params.decoded = b64urlJson(params.request);
    out.push(params);
  }
  return out;
}

// Verify-before-declare: is this response actually an MPP challenge?
function isMppResponse(res, body) {
  const wa = res.headers.get("www-authenticate") || "";
  if (/(^|,\s*)Payment\s/i.test(wa)) return true;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/problem+json")) {
    try {
      const j = JSON.parse(body);
      if (j && typeof j.type === "string" && /\/problems\/payment-required$/.test(j.type))
        return true;
    } catch {}
  }
  return false;
}

function isFiat(currency) {
  return typeof currency === "string" && FIAT_DECIMALS[currency.toLowerCase()] != null;
}
// Decimals we're SURE of, else null (→ don't decode).
function minorUnitDecimals(currency) {
  if (isFiat(currency)) return FIAT_DECIMALS[currency.toLowerCase()];
  return null; // token addresses / unknown fiat: unverified → null
}
function normCurrency(currency) {
  if (isFiat(currency)) return currency.toUpperCase();
  if (typeof currency === "string" && USDC_ASSETS.has(currency.toLowerCase())) return "USDC";
  return currency || null;
}
function recipientKind(method, recipient) {
  if (typeof recipient === "string" && /^0x[0-9a-f]+$/i.test(recipient)) return "evm-address";
  if (method === "stripe") return "spt-network";
  return "address";
}

// Mutates `read` into an MPP CleanRead. Mirrors buildX402Read's contract.
function buildMppRead(read, res, body) {
  const challenges = parsePaymentChallenges(res.headers.get("www-authenticate"));

  // Prefer a challenge we can price today (fiat/SPT), else the first present.
  const priced =
    challenges.find((c) => c.decoded && isFiat(c.decoded.currency)) || challenges[0] || null;

  // A live 402 means the merchant will sell right now.
  read.available = "in_stock";

  let payTo = null,
    total = null,
    currency = null;

  if (priced && priced.decoded) {
    const d = priced.decoded;
    if (d.recipient) {
      payTo = {
        kind: recipientKind(priced.method, d.recipient),
        value: d.recipient,
        chain: priced.method || null,
      };
    }
    const dec = minorUnitDecimals(d.currency);
    if (dec != null && d.amount != null) {
      const n = Number(d.amount);
      if (Number.isFinite(n)) {
        total = round2(n / Math.pow(10, dec));
        currency = normCurrency(d.currency);
      }
    } else {
      // crypto token-address (or unknown fiat): decimals unverified → don't guess.
      currency = normCurrency(d.currency);
      read.cuts.push(
        `MPP amount not decoded (base-unit decimals unverified for currency ${d.currency})`
      );
    }
  }

  read.price = { total, currency };
  read.payable = { rail: "mpp", payTo, instruction: PAY_MPP };

  // Verdict: autonomous rail + known price + not out of stock → autonomous.
  if (total != null && read.available !== "out_of_stock") {
    read.outcome = "autonomous";
    read.reason = null;
  } else {
    read.outcome = "human_checkout";
    read.reason =
      "MPP rail present but price could not be decoded from the challenge (crypto base-unit decimals unverified).";
    read.cuts.push("MPP price not decoded");
  }
  return read;
}

// ---------------------------------------------------------------------------
// UCP — GET /.well-known/ucp  (assistant/human-in-loop → enriched human_checkout)
// ---------------------------------------------------------------------------

// Structural check: it must BE a UCP manifest, not just any JSON at that path.
function isUcpManifest(j) {
  return !!(
    j &&
    typeof j === "object" &&
    j.ucp &&
    typeof j.ucp.version === "string" &&
    Array.isArray(j.ucp.capabilities)
  );
}

async function probeUcp(origin) {
  try {
    const res = await fetch(`${origin}/.well-known/ucp`, {
      method: "GET",
      redirect: "manual", // a catch-all 3xx→homepage must NOT count as "present"
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(WELL_KNOWN_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const j = JSON.parse(await res.text()); // non-JSON → throws → null
    return isUcpManifest(j) ? j : null;
  } catch {
    return null; // 404 / redirect / timeout / junk → no rail claimed
  }
}

function ucpInstruction(origin, j) {
  const caps = (j.ucp.capabilities || [])
    .map((c) => c && c.name)
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
  const handlers = (j.payment && Array.isArray(j.payment.handlers) ? j.payment.handlers : [])
    .map((h) => h && h.id)
    .filter(Boolean)
    .join(", ");
  return (
    `Agent-readable checkout via UCP (Universal Commerce Protocol). Manifest: ${origin}/.well-known/ucp. ` +
    `Capabilities: ${caps || "(none listed)"}. Payment handlers: ${handlers || "(none listed)"}. ` +
    `Assistant/human-in-loop checkout — NOT an autonomous agent rail. Merchant Key reads; it never checks out.`
  );
}

// Enrich ONLY a readable-but-human_checkout read. Latency guard: caller invokes
// this only on that branch, so the autonomous (402) path never pays the extra GET.
async function enrichUcp(read, origin) {
  if (read.outcome !== "human_checkout") return read;
  const manifest = await probeUcp(origin);
  if (manifest) {
    read.payable = { rail: "ucp", payTo: null, instruction: ucpInstruction(origin, manifest) };
    read.reason =
      "Readable product; UCP checkout surface available (assistant/human-in-loop). No autonomous agent rail.";
    read.cuts.push("UCP manifest present (/.well-known/ucp)");
  }
  return read;
}

export {
  // MPP
  isMppResponse,
  buildMppRead,
  parsePaymentChallenges,
  // UCP
  isUcpManifest,
  probeUcp,
  enrichUcp,
};

/* ---------------------------------------------------------------------------
 * HOOK POINTS in read.js's decodeMerchant  (NOT applied — for review)
 *
 * import { isMppResponse, buildMppRead, enrichUcp } from "./rails.js";
 *
 * (1) In the 402 branch, AFTER the x402 attempt fails but BEFORE the
 *     "unparseable payment challenge" error:
 *
 *       if (status === 402 || headerChallenge) {
 *         const ch = usableChallenge(tryParseChallenge(body))
 *                 || usableChallenge(tryParseChallenge(headerChallenge));
 *         if (ch) return buildX402Read(read, ch);
 *         if (isMppResponse(res, body)) return buildMppRead(read, res, body);   // <-- NEW
 *         read.reason = "Got a 402 ... couldn't parse a usable challenge.";
 *         ...
 *       }
 *
 * (2) In the readable branch, AFTER applySurface:
 *
 *       const result = applySurface(read, found);
 *       if (result.outcome === "human_checkout") await enrichUcp(result, parsed.origin);  // <-- NEW
 *       return result;
 *
 * Plus additive schema/doc: add "mpp" and "ucp" to the rail enum in blankRead,
 * read.js header, README, index.js START_HERE, docs/SPEC.md.
 * ------------------------------------------------------------------------- */
