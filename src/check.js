/**
 * MAP — CHECK module (v1.1 DRAFT): "Can AI read your business site?"
 *
 * ADDITIVE + UNWIRED. read.js untouched. Not imported into the server yet.
 *
 * TWO PASSES, because different AI readers see different things — and the
 * DISAGREEMENT between them is the finding no competitor checks for:
 *
 *   1. Raw pass  — what a plain fetcher/crawler sees (decode-merchant as-is):
 *      JSON-LD / OpenGraph structured data. This is the kind of access search
 *      indexes and many machine/agent services rely on. (We do NOT claim a given
 *      crawler feeds model training — that's unknowable and not the point.)
 *   2. Rendered pass — what a JS-rendering "browsing" AI reads, via Jina Reader:
 *      the readable page content AFTER JavaScript runs. Jina STRIPS structured
 *      tags and returns clean text — which is exactly what a browsing AI reads,
 *      so we assess FACTS-IN-TEXT here, not JSON-LD.
 *
 * A Wix/Squarespace site can be readable to a browsing AI and invisible to plain
 * crawlers at the same time. One verdict lies in one direction; two tell the truth.
 *
 * Honesty: this claims only what it can show — "can AI read your site," NOT
 * "what ChatGPT says about you" (ChatGPT usually reads its search index + reviews/
 * directories, not your live homepage). No false alarms.
 *
 * Third-party notice: the rendered pass sends the URL to Jina Reader. Renderer is
 * SWAPPABLE (free Jina now; Firecrawl/self-hosted later) so a paid fallback can
 * drop in when free-tier limits/uptime become the product's problem at volume.
 */

import { decodeMerchant } from "./read.js";

const JINA_TIMEOUT_MS = 45000;
const JINA_BASE = "https://r.jina.ai/";
const USER_AGENT = "MAP/1.1 (Maraventano Agent Protocol; readability check; reads, never pays)";

// --- Swappable renderer -----------------------------------------------------
// Default: Jina Reader (free, renders JS, returns readable markdown/text).
// Any drop-in must be: async (url) => string (the rendered readable content).
async function renderViaJina(url) {
  const res = await fetch(JINA_BASE + url, {
    method: "GET",
    headers: { "user-agent": USER_AGENT, accept: "text/plain", "x-return-format": "markdown" },
    signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jina render failed: HTTP ${res.status}`);
  return await res.text();
}

// --- Facts heuristic on rendered readable text ------------------------------
// Not an LLM read (that's the fuller "business-facts pass"); a presence scan so
// the report can say which basics a reader would actually find on the page.
function scanFacts(text) {
  const t = text || "";
  return {
    price: /(?:\$|usd|eur|£|€)\s?\d/i.test(t) || /\bprices?\b/i.test(t),
    contact: /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t) || /\+?\d[\d\-().\s]{7,}\d/.test(t),
    hours: /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/i.test(t) &&
      /\b(a\.?m\.?|p\.?m\.?|open|closed|hours)\b/i.test(t),
    location: /\b\d{5}(?:-\d{4})?\b/.test(t) ||
      /\b(street|st\.|ave\.?|avenue|road|rd\.|blvd|suite|ste\.)\b/i.test(t),
    booking: /\b(book|appointment|schedule|contact us|get a quote|call now|request)\b/i.test(t),
  };
}

// --- The check --------------------------------------------------------------
async function checkSite(url, { render = renderViaJina } = {}) {
  // 1) Raw pass — plain crawler / structured-data view.
  const raw = await decodeMerchant(url);
  const rawReadable = raw.outcome !== "unreadable";
  // decode-merchant only fills what/price from JSON-LD/OG, so this = "structured data present".
  const structuredData = !!(raw.what || raw.price.total != null);

  // 2) Rendered pass — browsing-AI view (JS executed).
  let rendered = { retrieved: false, chars: 0, facts: null, error: null };
  try {
    const text = await render(url);
    const chars = (text || "").length;
    rendered = {
      retrieved: !!(text && text.trim().length > 200),
      chars,
      facts: scanFacts(text),
      error: null,
    };
  } catch (e) {
    rendered.error = e && e.message ? e.message : String(e);
  }

  // The finding lives in the disagreement.
  let disagreement = null;
  if (!rawReadable && rendered.retrieved) {
    disagreement =
      "Readable only after JavaScript runs. Browsing AIs may read you, but plain crawlers and many " +
      "machine/agent tools that don't render JS cannot — you depend on structured data you don't publish.";
  } else if (rawReadable && !rendered.retrieved && !rendered.error) {
    disagreement = "Structured data present but rendered content thin — unusual; worth a human look.";
  }

  return {
    url,
    plainCrawler: { readable: rawReadable, structuredData, outcome: raw.outcome },
    browsingAI: rendered,
    disagreement,
    // Plain-language headline the page can render directly.
    verdict: {
      readableByPlainCrawlers: rawReadable ? "yes" : "no",
      readableByBrowsingAIs: rendered.retrieved ? "yes" : rendered.error ? "unknown" : "no",
      structuredDataPresent: structuredData ? "yes" : "no",
    },
    cleanRead: raw, // the full raw-pass CleanRead, for detail
    notice:
      "The browsing-AI view fetches your page through Jina Reader, a third-party rendering service.",
  };
}

// --- LLM facts pass (SEPARATE, gate-able step) ------------------------------
// The free check = raw + rendered passes above (instant, no per-use cost). THIS
// is the paid/gated step: a real read of the rendered content that writes the
// plain-language findings DIRECTLY (its text IS the report) and returns a
// three-state verdict. Runs server-side with an API key — never ships in the
// npm client. Kept separate so it can be gated behind a "full report" button
// without touching the free passes.
const FACTS_MODEL = process.env.MAP_FACTS_MODEL || "claude-haiku-4-5-20251001";
const FACTS_MAX_CHARS = 12000; // small-biz pages are small; bound the cost.

const FACTS_PROMPT = (content) => `You are MAP's business-readability reader. Below is the rendered text of a business website, exactly as a browsing AI would read it after JavaScript runs.

Assess ONLY what is actually present in this text. Do not invent facts. Write plain-language findings a non-technical business owner understands — say specifically which of these a reader can find and which are blank:
- business name
- what they do / services offered
- prices or how to get a quote
- hours
- location / service area
- contact (phone/email)
- how to book or hire them

Be concrete, e.g. "Your hours appear nowhere," "Your prices exist only inside an image a reader can't parse," "A reader can find your phone number." Then, on the LAST line, output exactly one of:
VERDICT: readable
VERDICT: readable-but-empty
VERDICT: unreadable

Do NOT claim anything about whether an AI will recommend the business — out of scope and unknowable.

--- RENDERED SITE CONTENT ---
${content}`;

// Default LLM caller: Anthropic Messages API, cheap model, key from env.
// Swappable: pass {llm: async (prompt) => string} to use any provider.
async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "LLM facts pass needs an API key (ANTHROPIC_API_KEY). This is the gated step — the free check (raw + rendered) runs without it."
    );
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: FACTS_MODEL, max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`LLM call failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || "";
}

// The gated facts pass. Its report text IS the deliverable — same string the
// page renders and the npm tool prints. One build, both doors.
async function factsReport(url, { render = renderViaJina, llm = callAnthropic } = {}) {
  const text = await render(url);
  const content = (text || "").slice(0, FACTS_MAX_CHARS);
  const raw = await llm(FACTS_PROMPT(content));

  const m = raw.match(/VERDICT:\s*(readable-but-empty|readable|unreadable)/i);
  const verdict = m ? m[1].toLowerCase() : "unknown"; // readable | readable-but-empty | unreadable
  const report = raw.replace(/^VERDICT:.*$/im, "").trim();

  return {
    url,
    verdict,
    report,
    model: FACTS_MODEL,
    notice:
      "Rendered via Jina Reader (third party); facts read by an LLM. This step carries a small per-check cost.",
  };
}

export { checkSite, renderViaJina, scanFacts, factsReport };
