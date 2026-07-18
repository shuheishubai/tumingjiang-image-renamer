import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [dataArgument, deliveryArgument] = process.argv.slice(2);
if (!dataArgument || !deliveryArgument) {
  throw new Error('Usage: node test-gateway.mjs <data-dir> <delivery.txt>');
}

const dataDir = resolve(dataArgument);
const delivery = readFileSync(resolve(deliveryArgument), 'utf8');
const ownerKey = delivery.match(/管理员密钥：([^\r\n]+)/)?.[1]?.trim()
  || delivery.match(/TJ-OWNER-[A-Za-z0-9_-]+/)?.[0];
if (!ownerKey) throw new Error('Owner key missing from delivery file.');

const port = 3100;
const child = spawn(process.execPath, [resolve(import.meta.dirname, 'server.mjs')], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
  stdio: 'ignore',
  windowsHide: true
});

const base = `http://127.0.0.1:${port}`;
const pause = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await pause(100);
  }
  throw new Error('Gateway did not start.');
}

async function jsonRequest(path, options = {}, cookie = '') {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

try {
  await waitForHealth();
  const anonymous = await fetch(`${base}/check`);
  if (anonymous.status !== 401) throw new Error('Anonymous access was not blocked.');

  const ownerLogin = await jsonRequest('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ key: ownerKey })
  });
  if (!ownerLogin.response.ok || ownerLogin.body.role !== 'owner') throw new Error('Owner login failed.');
  const ownerCookie = ownerLogin.response.headers.get('set-cookie')?.split(';')[0] || '';
  const ownerCheck = await fetch(`${base}/check-owner`, { headers: { Cookie: ownerCookie } });
  if (ownerCheck.status !== 204) throw new Error('Owner session check failed.');
  const anonymousAiStatus = await fetch(`${base}/api/ai/status`);
  if (anonymousAiStatus.status !== 401) throw new Error('Anonymous AI status access was not blocked.');
  const ownerAiStatus = await jsonRequest('/api/ai/status', { method: 'GET' }, ownerCookie);
  if (!ownerAiStatus.response.ok || ownerAiStatus.body.model !== 'gpt-image-2' || typeof ownerAiStatus.body.configured !== 'boolean' || !ownerAiStatus.body.chatModel) {
    throw new Error('Owner AI status check failed.');
  }

  const anonymousIngest = await jsonRequest('/api/ingest/orders', {
    method: 'POST',
    body: JSON.stringify({ requestText: 'anonymous order' })
  });
  if (anonymousIngest.response.status !== 401) throw new Error('Anonymous order ingestion was not blocked.');

  const tokenCreated = await jsonRequest('/api/access/ingest-token', {
    method: 'POST',
    body: JSON.stringify({ label: 'Gateway regression test' })
  }, ownerCookie);
  if (tokenCreated.response.status !== 201 || !/^tj_ingest_[A-Za-z0-9_-]{40,}$/.test(tokenCreated.body.token)) {
    throw new Error('Least-privilege ingest token creation failed.');
  }

  const ingested = await jsonRequest('/api/ingest/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenCreated.body.token}` },
    body: JSON.stringify({
      conversationKey: 'test-conversation',
      customerName: 'Test Customer',
      title: 'Test Photo Order',
      requestText: 'Resize to 200 x 300 pixels',
      sourceFingerprint: 'gateway-test-fingerprint'
    })
  });
  if (ingested.response.status !== 201 || ingested.body.order?.source !== 'xianyu') {
    throw new Error('Authorized order ingestion failed.');
  }

  const invalidIngest = await jsonRequest('/api/ingest/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer tj_ingest_invalid_invalid_invalid_invalid_invalid' },
    body: JSON.stringify({ requestText: 'invalid token' })
  });
  if (invalidIngest.response.status !== 401) throw new Error('Invalid ingest token was accepted.');

  const orderList = await jsonRequest('/api/orders', { method: 'GET' }, ownerCookie);
  if (!orderList.response.ok || !orderList.body.orders.some((order) => order.id === ingested.body.order.id)) {
    throw new Error('Owner order listing failed.');
  }

  const sourceBytes = Buffer.from('test-image-bytes');
  const orderUpload = await jsonRequest(`/api/orders/${ingested.body.order.id}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-File-Name': encodeURIComponent('source.jpg'),
      'X-File-Kind': 'source'
    },
    body: sourceBytes
  }, ownerCookie);
  if (orderUpload.response.status !== 201 || !orderUpload.body.file?.id) {
    throw new Error('Owner order file upload failed.');
  }
  const orderDownload = await fetch(`${base}/api/orders/${ingested.body.order.id}/files/${orderUpload.body.file.id}`, {
    headers: { Cookie: ownerCookie }
  });
  if (!orderDownload.ok || !Buffer.from(await orderDownload.arrayBuffer()).equals(sourceBytes)) {
    throw new Error('Owner order file download failed.');
  }

  const anonymousUpload = await fetch(`${base}/api/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    body: Buffer.from('PK\u0003\u0004anonymous')
  });
  if (anonymousUpload.status !== 401) throw new Error('Anonymous temporary upload was not blocked.');

  const documentBytes = Buffer.from('PK\u0003\u0004temporary-docx-test');
  const temporaryUpload = await jsonRequest('/api/downloads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'X-File-Name': encodeURIComponent('测试文档.docx')
    },
    body: documentBytes
  }, ownerCookie);
  if (temporaryUpload.response.status !== 201 || !/^\/d\/[A-Za-z0-9_-]{32}$/.test(temporaryUpload.body.url)) {
    throw new Error('Temporary Word download link creation failed.');
  }
  const temporaryHead = await fetch(`${base}${temporaryUpload.body.url}`, { method: 'HEAD' });
  if (!temporaryHead.ok || !/attachment/.test(temporaryHead.headers.get('content-disposition') || '')) {
    throw new Error('Temporary Word download headers were invalid.');
  }
  const temporaryDownload = await fetch(`${base}${temporaryUpload.body.url}`);
  if (!temporaryDownload.ok || !Buffer.from(await temporaryDownload.arrayBuffer()).equals(documentBytes)) {
    throw new Error('Temporary Word download bytes changed.');
  }

  const created = await jsonRequest('/api/access/keys', {
    method: 'POST',
    body: JSON.stringify({ label: '回归测试密钥', expiresDays: 1 })
  }, ownerCookie);
  if (!created.response.ok || !/^\d{6}$/.test(created.body.key)) {
    throw new Error('Six-digit viewer access code creation failed.');
  }

  const viewerLogin = await jsonRequest('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ key: created.body.key })
  });
  if (!viewerLogin.response.ok || viewerLogin.body.role !== 'viewer') throw new Error('Viewer login failed.');
  const viewerCookie = viewerLogin.response.headers.get('set-cookie')?.split(';')[0] || '';
  const viewerAiStatus = await fetch(`${base}/api/ai/status`, { headers: { Cookie: viewerCookie } });
  if (viewerAiStatus.status !== 403) throw new Error('Viewer access to owner-only AI endpoint was not blocked.');
  const viewerOrders = await fetch(`${base}/api/orders`, { headers: { Cookie: viewerCookie } });
  if (viewerOrders.status !== 403) throw new Error('Viewer access to owner-only orders was not blocked.');

  const disabled = await jsonRequest(`/api/access/keys/${created.body.record.id}`, {
    method: 'DELETE',
    body: '{}'
  }, ownerCookie);
  if (!disabled.response.ok) throw new Error('Viewer key disable failed.');
  const disabledCheck = await fetch(`${base}/check`, { headers: { Cookie: viewerCookie } });
  if (disabledCheck.status !== 401) throw new Error('Disabled key session remained active.');

  let blockedAttempt;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    blockedAttempt = await jsonRequest('/api/access/login', {
      method: 'POST',
      body: JSON.stringify({ key: '000000' })
    });
  }
  if (blockedAttempt.response.status !== 429 || blockedAttempt.response.headers.get('retry-after') !== '1800') {
    throw new Error('Six-digit access-code brute-force lockout failed.');
  }

  console.log('Validated gateway authentication, owner-only AI and order access, least-privilege ingestion, file storage, temporary Word downloads, key lifecycle, session revocation, and brute-force lockout.');
} finally {
  child.kill();
}
