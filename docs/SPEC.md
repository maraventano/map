# MAP — Maraventano Agent Protocol · spec for an agent

**npm:** `@maraventano/map` · **version:** 1.0.4 · **transport:** one MCP server on stdio · **dep:** `@modelcontextprotocol/sdk` only · **Node ≥18**

## What it is
One MCP server, three parts. Each does one thing and stops. Together they let an agent **read** any merchant on the open web into one shape, **decide** if it can pay autonomously, and **publish** its own catalog to be found.

| Part | Name | Job | Tools |
|---|---|---|---|
| read | **Merchant Key** | Decode any product URL → one CleanRead | `decode-merchant` |
| pay | **Provisions** | Teach the agent to use the wallet it already has | 18 lessons |
| publish | **Atlas** | Point the decoder inward; serve your own catalog | `publish-catalog`, `get-catalog`, `get-product` |

Plus `start-here` (orientation). **The boundary, all three parts:** MAP reads, explains, persists, serves. It **never signs, pays, holds keys, transacts, or stores cards.** Teacher, not butler.

## The CleanRead (the only output shape) — `schemaVersion: "map/v1"`
```jsonc
{
  "schemaVersion": "map/v1",
  "sourceUrl": "https://…",
  "what":   "Void Latte — Meditation on emptiness…",   // name + identity, one string
  "who":    "underground.substratesymposium.com",       // seller
  "price":  { "total": 1.99, "currency": "USDC" },       // total if knowable, else null
  "available": "in_stock",                               // in_stock | out_of_stock | unknown
  "payable": {
    "rail": "x402",        // x402 | ap2 | acp | coinbase | stripe | http-json | walletconnect | human_checkout | unknown
    "payTo": { "kind": "evm-address", "value": "0x…", "chain": "eip155:8453" },
    "instruction": "Agent-payable via x402 — see read-this-challenge, how-do-i-pay."
  },
  "outcome": "autonomous", // autonomous | human_checkout | unreadable
  "reason":  null,
  "cuts":    []            // 1-line actionable gaps
}
```
**Five fields and a verdict. No sixth.** Unknown is `null`/`"unknown"`, never omitted — so any four reads sort against each other.

## The three outcomes
- **`autonomous`** — a machine-payable rail exists, price known, in stock. The agent can buy it itself.
- **`human_checkout`** — readable, no agent-payable rail. Returns the clean card anyway. **The common case, and a success.**
- **`unreadable`** — no usable price/product. Says why in `reason`. Never guesses.

## How `decode-merchant` reads (v1)
JSON-LD (`schema.org` Product/Offer) → OpenGraph product tags → x402 402-challenge → else `unreadable`. Read-only `GET`. Follows **one same-origin redirect** (noted in `cuts`); **refuses cross-origin redirects and chains**. No headless browser (JS-only pages read `unreadable`), no secondary-endpoint probing.

## Detection discipline (the sacred rule)
> MAP **never infers a rail** from branding, checkout buttons, script tags, marketing copy, or platform names. Only a verifiable machine-readable signal sets a rail. If none is found → `human_checkout`.

**v1.0.x detects `x402` only.** All other rail values are reserved schema — real in the enum, not yet detected. A normal Shopify/Stripe page correctly reads `human_checkout`. **False `human_checkout` is acceptable. False `autonomous` is dangerous and forbidden.**

## Provisions — the 18 pay lessons
Foundation → `what-is-a-wallet`, `what-is-usdc`, `get-a-wallet`, `configure-wallet-skills`, `fund-my-wallet`, `explain-my-wallet`, `choose-your-wallet-mode`.
Transact → `what-is-x402` → `read-this-challenge` → `how-do-i-pay` → `verify-my-purchase` → `paid-vs-delivered` → `test-payment`.
Context/rails → `who-am-i-to-this-merchant`, `what-is-ap2`, `what-is-acp`, `subscriptions-and-session-keys`.
Diagnostics → `what-went-wrong`. **Every lesson explains what to run; none signs for you.**

## Atlas — publish
`publish-catalog` runs `decode-merchant` on the merchant's *own* product URLs, collects the CleanReads → `./catalog.json`, and writes `./.well-known/map.json` (a thin discovery pointer, not a product schema). `get-catalog`/`get-product` are the read surface other agents call. **Trust boundary (v1, named not built):** trusts the merchant's self-decode; independent re-read/diff, signed manifests, periodic re-audit are future work. Safety property that already holds: the payment rail enforces the *real* price at settlement — a bad manifest can misstate soft fields (stock), never overcharge.

## v1.1 roadmap (not built — in design)
Atlas gains **truthful ACP + UCP manifest emission**: generate/verify/serve `/.well-known/acp/manifest.json` (spec `2026-04-17`) and `/.well-known/ucp` (spec `2026-01-11`), declaring only endpoints Atlas can **verify respond**. Scope stays document-generation, never standing up checkout infra. AP2 is not a merchant-URL detector (its autonomous path settles via x402, already detected). ACP/UCP land as enriched `human_checkout`, never `autonomous`.

## Run
```
npx @maraventano/map    # 23 tools on stdio (read · pay · publish)
npm run smoke           # Merchant Key DoD — four decode cases (live Underground x402 item)
npm run smoke:publish   # Atlas DoD — publish-catalog → catalog.json → get-product → .well-known
```

## License
Dual-licensed: **free for individuals and agents; commercial license required for companies.** Not MIT. Not affiliated with Coinbase, Stripe, Google, Shopify, or any company named in its docs.

*By Lisa Maraventano, with Claude · Clarksdale, Mississippi*
