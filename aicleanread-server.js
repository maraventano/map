/**
 * aicleanread — the app server (for the VPS, behind nginx, under pm2).
 * No framework, no deps: Node built-in http + the cleanread engine.
 *
 *   GET  /                 -> the storefront page
 *   GET  /api/preview?url= -> free heuristic preview (no key, no cost)
 *   GET  /api/generate?session_id=  -> verify the Stripe session was PAID, then
 *                                       generate the schema + llms.txt for the paid URL
 *
 * Keys come from the pm2 env (ANTHROPIC_API_KEY, STRIPE_SECRET_KEY). Never in code.
 * Binds localhost; nginx terminates TLS for aicleanread.com and proxies here.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewFree, generate } from "./src/emit.js";
import { verifyPaidSession } from "./src/paygate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const PAGE = path.join(__dirname, "docs", "aicleanread.html");

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/" || u.pathname === "/index.html") {
      const html = await readFile(PAGE, "utf-8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (u.pathname === "/api/preview") {
      const url = u.searchParams.get("url");
      if (!url) return json(res, 400, { error: "missing url" });
      return json(res, 200, await previewFree(url));
    }

    if (u.pathname === "/api/generate") {
      const sid = u.searchParams.get("session_id");
      const check = await verifyPaidSession(sid);
      if (!check.paid) return json(res, 402, { error: "payment not verified", reason: check.reason });
      if (!check.url) return json(res, 400, { error: "no site url attached to the paid session" });
      const out = await generate(check.url);
      return json(res, 200, {
        url: check.url,
        scriptTag: out.scriptTag,
        llmsTxt: out.llmsTxt,
        instructions: out.instructions,
      });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: "server error", detail: e && e.message });
  }
});

server.listen(PORT, () => console.error("aicleanread server listening on :" + PORT));
