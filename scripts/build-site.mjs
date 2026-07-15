import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "site/index.html"), "utf8");
const css = await readFile(resolve(root, "site/styles.css"), "utf8");
const js = await readFile(resolve(root, "site/app.js"), "utf8");
const out = resolve(root, "dist/server/index.js");
const worker = `const ASSETS = ${JSON.stringify({
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/index.html": { body: html, type: "text/html; charset=utf-8" },
  "/styles.css": { body: css, type: "text/css; charset=utf-8" },
  "/app.js": { body: js, type: "text/javascript; charset=utf-8" },
})};
const security = {
  "cache-control": "public, max-age=0, must-revalidate",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\\nAllow: /\\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const asset = ASSETS[url.pathname] || ASSETS["/"];
    return new Response(request.method === "HEAD" ? null : asset.body, { headers: { ...security, "content-type": asset.type } });
  }
};
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, worker, "utf8");
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
await cp(resolve(root, ".openai/hosting.json"), resolve(root, "dist/.openai/hosting.json"));
console.log("Built dist/server/index.js");
