import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const pagePath = resolve(import.meta.dirname, "../site/index.html");
const port = Number(process.env.PORT || 4173);
const server = createServer(async (request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  const html = await readFile(pagePath, "utf8");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
});
server.listen(port, "127.0.0.1", () => console.log(`Local URL: http://127.0.0.1:${port}/`));
