import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [baseUrlArgument, deliveryFileArgument, outputFileArgument] = process.argv.slice(2);
if (!baseUrlArgument || !deliveryFileArgument || !outputFileArgument) {
  throw new Error('Usage: node create-viewer-code.mjs <base-url> <owner-key-delivery-file> <output-file>');
}

const baseUrl = new URL(baseUrlArgument);
const deliveryFile = resolve(deliveryFileArgument);
const outputFile = resolve(outputFileArgument);
if (existsSync(outputFile)) {
  throw new Error('Refusing to overwrite an existing access-code delivery file.');
}

const delivery = await readFile(deliveryFile, 'utf8');
const ownerKey = delivery.match(/管理员密钥：([^\r\n]+)/)?.[1]?.trim()
  || delivery.match(/TJ-OWNER-[A-Za-z0-9_-]+/)?.[0];
if (!ownerKey) throw new Error('Owner key not found in delivery file.');

const request = (path, init = {}) => fetch(new URL(path, baseUrl), {
  redirect: 'manual',
  ...init
});

const ownerLogin = await request('/api/access/login', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: baseUrl.origin
  },
  body: JSON.stringify({ key: ownerKey })
});
if (ownerLogin.status !== 200) {
  throw new Error(`Owner login failed with HTTP ${ownerLogin.status}.`);
}
const ownerCookie = ownerLogin.headers.get('set-cookie')?.split(';', 1)[0] || '';

const creation = await request('/api/access/keys', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: ownerCookie,
    origin: baseUrl.origin
  },
  body: JSON.stringify({
    label: '常用六位访问码',
    expiresDays: 0
  })
});
const created = await creation.json();
if (creation.status !== 201 || !/^\d{6}$/.test(created.key || '')) {
  throw new Error(`Six-digit access-code creation failed with HTTP ${creation.status}.`);
}

const viewerLogin = await request('/api/access/login', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: baseUrl.origin
  },
  body: JSON.stringify({ key: created.key })
});
if (viewerLogin.status !== 200) {
  throw new Error(`Viewer login verification failed with HTTP ${viewerLogin.status}.`);
}

await writeFile(outputFile, [
  '片刻网站——常用六位访问码',
  '',
  created.key,
  '',
  `网站地址：${baseUrl.href}`,
  '用途：给普通用户登录图片工具。',
  '管理员恢复密钥仍单独保留，请勿把管理员密钥发给普通用户。',
  ''
].join('\r\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });

await request('/api/access/logout', {
  method: 'POST',
  headers: {
    cookie: ownerCookie,
    origin: baseUrl.origin
  }
});

console.log('Created and verified one six-digit viewer code; delivery file written without exposing the code.');
