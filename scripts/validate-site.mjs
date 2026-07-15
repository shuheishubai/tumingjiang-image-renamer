import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "site/index.html"), "utf8");
assert.match(html, /<html lang="zh-CN">/);
assert.match(html, /type="file"[^>]+accept="image\/\*"[^>]+multiple/);
assert.match(html, /function cleanName/);
assert.match(html, /async function makeZip/);
assert.match(html, /图片仅在你的设备中处理/);

const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "inline application script is present");
new Function(inlineScript);

const workerUrl = pathToFileURL(resolve(root, "dist/server/index.js")).href + `?v=${Date.now()}`;
const worker = (await import(workerUrl)).default;
const response = await worker.fetch(new Request("https://example.test/"));
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type") || "", /text\/html/);
assert.match(response.headers.get("content-security-policy") || "", /connect-src 'none'/);
assert.match(await response.text(), /图名匠/);
console.log("Validated responsive page, client script, privacy policy, and production worker response.");
