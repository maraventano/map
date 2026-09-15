/**
 * MAP — EMIT module (v1): the auto-fill schema generator.
 *
 * Product: "AIs read differently. Make sure your site is visible." — $99, one-and-done.
 * Reads a business's OWN site (cleanread engine), extracts its facts, and emits
 * paste-once machine-readable code: a schema.org JSON-LD <script> block + an
 * /llms.txt. The merchant pastes it into their own site. We never touch their site.
 *
 * Flow: generate first (preview) -> pay $99 -> unlock full code.
 *
 * ADDITIVE. Not wired into any server. read.js/check.js untouched.
 * The deterministic emitter (emitSchema / emitLlmsTxt) needs no key and is tested here.
 * extractFacts() needs an LLM key AT RUNTIME (runs on the hosted app), swappable.
 */

import { renderViaJina, scanFacts } from "./check.js";

// ---------------------------------------------------------------------------
// Structured facts extraction (LLM; swappable; needs a key at runtime)
// ---------------------------------------------------------------------------
const FACTS_MODEL = process.env.MAP_FACTS_MODEL || "claude-haiku-4-5-20251001";
const FACTS_MAX_CHARS = 12000;

const EXTRACT_PROMPT = (content, url) => `You are extracting a local business's facts from the rendered text of its OWN website, to build schema.org markup. Use ONLY what is actually present in the text. Do not invent. For anything absent, use null.

Return a STRICT JSON object — no prose, no code fences — with exactly these keys:
{
  "name": string|null,
  "businessType": string|null,   // best schema.org LocalBusiness subtype, e.g. "HairSalon","Attorney","AccountingService","Restaurant","Plumber","Dentist"; if unsure use "LocalBusiness"
  "description": string|null,     // one sentence, drawn from the site
  "telephone": string|null,
  "email": string|null,
  "streetAddress": string|null,
  "addressLocality": string|null, // city
  "addressRegion": string|null,   // state/region
  "postalCode": string|null,
  "priceRange": string|null,      // e.g. "$$" or "$25-$60" if stated
  "openingHours": [ {"days": "Mo-Fr", "opens": "09:00", "closes": "17:00"} ] | null,
  "services": [ string ] | null,  // named services offered
  "sameAs": [ string ] | null     // social/profile URLs present on the page
}

URL: ${url}
--- RENDERED SITE CONTENT ---
${content}`;

async function callAnthropicJSON(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "extractFacts needs an API key (ANTHROPIC_API_KEY) — it runs on the hosted app, not in the client."
    );
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: FACTS_MODEL, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`LLM call failed: HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || "";
  const m = text.match(/\{[\s\S]*\}/); // pull the JSON object out even if wrapped
  return m ? JSON.parse(m[0]) : null;
}

async function extractFacts(url, { render = renderViaJina, llm = callAnthropicJSON } = {}) {
  const content = ((await render(url)) || "").slice(0, FACTS_MAX_CHARS);
  return await llm(EXTRACT_PROMPT(content, url));
}

// ---------------------------------------------------------------------------
// The emitter: facts -> VALID schema.org JSON-LD (deterministic, can't malform)
// ---------------------------------------------------------------------------

// Only emit an @type schema.org actually defines, else fall back to LocalBusiness.
// (Keeps the output valid even if extraction guesses a non-existent type like "BarberShop".)
const VALID_TYPES = new Set([
  "LocalBusiness", "HairSalon", "BeautySalon", "HealthAndBeautyBusiness", "DaySpa", "NailSalon",
  "Restaurant", "Bakery", "CafeOrCoffeeShop", "BarOrPub", "FoodEstablishment",
  "Attorney", "LegalService", "Notary", "AccountingService", "FinancialService", "InsuranceAgency",
  "Dentist", "Physician", "MedicalBusiness", "Optician",
  "Plumber", "Electrician", "HVACBusiness", "HousePainter", "RoofingContractor", "Locksmith",
  "HomeAndConstructionBusiness", "GeneralContractor", "MovingCompany", "Cleaning Service",
  "AutoRepair", "AutomotiveBusiness", "Store", "ProfessionalService", "RealEstateAgent",
  "TravelAgency", "ChildCare", "DryCleaningOrLaundry", "PetStore", "VeterinaryCare",
]);

const CLEAN = (s) => (typeof s === "string" && s.trim() ? s.trim() : undefined);

function buildAddress(f) {
  const a = { "@type": "PostalAddress" };
  let any = false;
  for (const [k, v] of [
    ["streetAddress", f.streetAddress], ["addressLocality", f.addressLocality],
    ["addressRegion", f.addressRegion], ["postalCode", f.postalCode],
  ]) {
    if (CLEAN(v)) { a[k] = v.trim(); any = true; }
  }
  return any ? a : undefined;
}

function buildHours(f) {
  if (!Array.isArray(f.openingHours)) return undefined;
  const out = f.openingHours
    .filter((h) => h && CLEAN(h.days) && CLEAN(h.opens) && CLEAN(h.closes))
    .map((h) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: h.days.trim(), opens: h.opens.trim(), closes: h.closes.trim() }));
  return out.length ? out : undefined;
}

function buildOffers(f) {
  if (!Array.isArray(f.services)) return undefined;
  const items = f.services.filter(CLEAN).map((s) => ({
    "@type": "Offer", itemOffered: { "@type": "Service", name: s.trim() },
  }));
  return items.length ? { "@type": "OfferCatalog", name: "Services", itemListElement: items } : undefined;
}

function emitSchema(facts, url) {
  const f = facts || {};
  const type = VALID_TYPES.has(CLEAN(f.businessType)) ? f.businessType.trim() : "LocalBusiness";
  const node = { "@context": "https://schema.org", "@type": type, "@id": url, url };
  if (CLEAN(f.name)) node.name = f.name.trim();
  if (CLEAN(f.description)) node.description = f.description.trim();
  if (CLEAN(f.telephone)) node.telephone = f.telephone.trim();
  if (CLEAN(f.email)) node.email = f.email.trim();
  const addr = buildAddress(f); if (addr) node.address = addr;
  if (CLEAN(f.priceRange)) node.priceRange = f.priceRange.trim();
  const hours = buildHours(f); if (hours) node.openingHoursSpecification = hours;
  const offers = buildOffers(f); if (offers) node.hasOfferCatalog = offers;
  const sameAs = Array.isArray(f.sameAs) ? f.sameAs.filter(CLEAN).map((s) => s.trim()) : [];
  if (sameAs.length) node.sameAs = sameAs;
  return node;
}

// The paste-once <head> block.
function schemaScriptTag(node) {
  return `<script type="application/ld+json">\n${JSON.stringify(node, null, 2)}\n</script>`;
}

// /llms.txt — plain-language summary for LLM crawlers.
function emitLlmsTxt(f, url) {
  const L = [];
  L.push(`# ${CLEAN(f.name) || "This business"}`);
  if (CLEAN(f.description)) L.push(`\n> ${f.description.trim()}`);
  L.push(`\n- Website: ${url}`);
  if (CLEAN(f.businessType)) L.push(`- Type: ${f.businessType.trim()}`);
  const loc = [f.addressLocality, f.addressRegion].filter(CLEAN).map((s) => s.trim()).join(", ");
  if (loc) L.push(`- Location: ${loc}`);
  if (CLEAN(f.telephone)) L.push(`- Phone: ${f.telephone.trim()}`);
  if (CLEAN(f.email)) L.push(`- Email: ${f.email.trim()}`);
  if (Array.isArray(f.services) && f.services.filter(CLEAN).length)
    L.push(`- Services: ${f.services.filter(CLEAN).join(", ")}`);
  if (Array.isArray(f.openingHours)) {
    const hrs = f.openingHours.filter((h) => h && CLEAN(h.days)).map((h) => `${h.days} ${h.opens}-${h.closes}`).join("; ");
    if (hrs) L.push(`- Hours: ${hrs}`);
  }
  return L.join("\n") + "\n";
}

// Preview = what the customer sees BEFORE paying (proof it worked, facts found).
// The full paste-ready code (scriptTag + llmsTxt) unlocks after payment.
function preview(facts, url) {
  const f = facts || {};
  const found = {
    name: !!CLEAN(f.name), type: VALID_TYPES.has(CLEAN(f.businessType)),
    phone: !!CLEAN(f.telephone), address: !!buildAddress(f),
    hours: !!buildHours(f), services: !!buildOffers(f), priceRange: !!CLEAN(f.priceRange),
  };
  return { name: CLEAN(f.name) || null, businessType: emitSchema(f, url)["@type"], found };
}

// FREE PREVIEW — the heuristic. NO LLM, NO key. Renders the site and does a
// presence scan so the human sees "we can read you, here's what we found" before
// paying. The real LLM extraction + emit happens only after payment (generate()).
async function previewFree(url, { render = renderViaJina } = {}) {
  const text = (await render(url)) || "";
  const facts = scanFacts(text); // {price, contact, hours, location, booking}
  let name = null;
  const t = text.match(/^\s*Title:\s*(.+)$/im);
  if (t) name = (t[1].trim().split(/[|\-–—·]/)[0] || "").trim() || null;
  const readable = text.trim().length > 300;
  return {
    url,
    readable,
    detectedName: name,
    found: {
      name: !!name,
      contact: facts.contact,
      hours: facts.hours,
      location: facts.location,
      services: facts.booking || /\b(services?|menu|pricing|offerings?)\b/i.test(text),
      price: facts.price,
    },
    note: readable
      ? "We can read your site. Unlock the full machine-readable code (schema.org + llms.txt), auto-built from your own site — one paste, done."
      : "Your site is hard for machines to read — which is exactly what this fixes.",
  };
}

// Full generation: read -> extract -> emit. (PAID path — runs the LLM.)
async function generate(url, opts = {}) {
  const facts = await extractFacts(url, opts);
  const node = emitSchema(facts, url);
  return {
    url, facts,
    preview: preview(facts, url),
    schemaJsonLd: node,
    scriptTag: schemaScriptTag(node),
    llmsTxt: emitLlmsTxt(facts || {}, url),
    instructions:
      "Paste the <script> block into your site's <head> — every builder (Wix, Squarespace, WordPress, GoDaddy) has a 'custom code' or 'header' box. Optional: add the llms.txt content as a file at yourdomain.com/llms.txt if your platform allows root files.",
  };
}

export { extractFacts, emitSchema, schemaScriptTag, emitLlmsTxt, preview, previewFree, generate };
