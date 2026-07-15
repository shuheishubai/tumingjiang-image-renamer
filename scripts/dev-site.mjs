import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const siteRoot = resolve(import.meta.dirname, "../site");
const port = Number(process.env.PORT || 4173);
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const server = createServer(async (request, response) => {
  if (request.url === "/favicon.ico") return response.writeHead(204).end();
  const [file, type] = assets[new URL(request.url || "/", "http://localhost").pathname] || assets["/"];
  const body = await readFile(resolve(siteRoot, file));
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
});
server.listen(port, "127.0.0.1", () => console.log(`Local URL: http://127.0.0.1:${port}/`));
