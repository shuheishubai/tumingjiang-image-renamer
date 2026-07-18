import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "site/index.html"), "utf8");
const css = await readFile(resolve(root, "site/styles.css"), "utf8");
const js = await readFile(resolve(root, "site/app.js"), "utf8");
const assistantHtml = await readFile(resolve(root, "site/assistant/index.html"), "utf8");
const assistantCss = await readFile(resolve(root, "site/assistant/assistant.css"), "utf8");
const assistantJs = await readFile(resolve(root, "site/assistant/assistant.js"), "utf8");
const cloudHtml = await readFile(resolve(root, "site/cloud/index.html"), "utf8");
const cloudCss = await readFile(resolve(root, "site/cloud/cloud.css"), "utf8");
const cloudJs = await readFile(resolve(root, "site/cloud/cloud.js"), "utf8");
const manifest = await readFile(resolve(root, "site/manifest.webmanifest"), "utf8");
const serviceWorker = await readFile(resolve(root, "site/sw.js"), "utf8");
const out = resolve(root, "dist/server/index.js");
const worker = `const ASSETS = ${JSON.stringify({
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/index.html": { body: html, type: "text/html; charset=utf-8" },
  "/styles.css": { body: css, type: "text/css; charset=utf-8" },
  "/app.js": { body: js, type: "text/javascript; charset=utf-8" },
  "/assistant": { body: assistantHtml, type: "text/html; charset=utf-8" },
  "/assistant/": { body: assistantHtml, type: "text/html; charset=utf-8" },
  "/assistant/index.html": { body: assistantHtml, type: "text/html; charset=utf-8" },
  "/assistant/assistant.css": { body: assistantCss, type: "text/css; charset=utf-8" },
  "/assistant/assistant.js": { body: assistantJs, type: "text/javascript; charset=utf-8" },
  "/cloud": { body: cloudHtml, type: "text/html; charset=utf-8" },
  "/cloud/": { body: cloudHtml, type: "text/html; charset=utf-8" },
  "/cloud/index.html": { body: cloudHtml, type: "text/html; charset=utf-8" },
  "/cloud/cloud.css": { body: cloudCss, type: "text/css; charset=utf-8" },
  "/cloud/cloud.js": { body: cloudJs, type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { body: manifest, type: "application/manifest+json; charset=utf-8" },
  "/sw.js": { body: serviceWorker, type: "text/javascript; charset=utf-8" },
})};
const security = {
  "cache-control": "public, max-age=0, must-revalidate",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "云端接单功能请使用腾讯云主站" }), { status: 503, headers: { ...security, "content-type": "application/json; charset=utf-8" } });
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\\nAllow: /\\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (env?.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        const headers = new Headers(assetResponse.headers);
        Object.entries(security).forEach(([key, value]) => headers.set(key, value));
        return new Response(request.method === "HEAD" ? null : assetResponse.body, { status: assetResponse.status, headers });
      }
    }
    const asset = ASSETS[url.pathname] || ASSETS["/"];
    return new Response(request.method === "HEAD" ? null : asset.body, { headers: { ...security, "content-type": asset.type } });
  }
};
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, worker, "utf8");
await rm(resolve(root, "dist/client"), { recursive: true, force: true });
await cp(resolve(root, "site"), resolve(root, "dist/client"), { recursive: true });
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
await cp(resolve(root, ".openai/hosting.json"), resolve(root, "dist/.openai/hosting.json"));
console.log("Built dist/server/index.js");
