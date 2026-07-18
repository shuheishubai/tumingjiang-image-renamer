import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, extname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORDERS = 300;
const MAX_FILES_PER_ORDER = 20;
const MAX_ORDER_STORAGE_BYTES = 500 * 1024 * 1024;
const RETENTION_MS = Number(process.env.ORDER_RETENTION_DAYS || 7) * DAY_MS;

function cleanText(value, maximum = 6000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, maximum);
}

function cleanStatus(value) {
  const allowed = new Set(['new', 'triage', 'processing', 'review', 'ready', 'done', 'cancelled']);
  return allowed.has(value) ? value : 'new';
}

function cleanImageUrls(value) {
  if (!Array.isArray(value)) return [];
  const urls = [];
  for (const candidate of value.slice(0, 20)) {
    try {
      const parsed = new URL(String(candidate));
      if (!['https:', 'http:'].includes(parsed.protocol)) continue;
      urls.push(parsed.toString().slice(0, 2000));
    } catch {
      // Ignore malformed image URLs.
    }
  }
  return [...new Set(urls)];
}

function safeFileName(value, fallback = 'image') {
  const input = cleanText(value, 120);
  const cleaned = basename(input)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function mimeExtension(type) {
  const known = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
  };
  return known[type] || '';
}

function publicOrder(order) {
  return {
    ...order,
    files: Array.isArray(order.files) ? order.files.map((file) => ({ ...file })) : []
  };
}

export function createOrderStore(dataDir, tokenSecret, audit = () => {}) {
  const root = join(dataDir, 'orders');
  const recordsPath = join(root, 'orders.json');
  const tokenPath = join(root, 'ingest-token.json');
  const filesRoot = join(root, 'files');
  const listeners = new Set();

  mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(recordsPath)) {
    writeFileSync(recordsPath, `${JSON.stringify({ version: 1, orders: [] }, null, 2)}\n`, { mode: 0o600 });
  }

  let orders = loadOrders();

  function loadOrders() {
    try {
      const parsed = JSON.parse(readFileSync(recordsPath, 'utf8'));
      return Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch {
      return [];
    }
  }

  function persist() {
    const temporaryPath = `${recordsPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, orders }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, recordsPath);
  }

  function broadcast(type, order) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(publicOrder(order))}\n\n`;
    for (const response of listeners) {
      try {
        response.write(payload);
      } catch {
        listeners.delete(response);
      }
    }
  }

  function storageBytes() {
    let total = 0;
    for (const directory of readdirSync(filesRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const directoryPath = join(filesRoot, directory.name);
      for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          total += statSync(join(directoryPath, entry.name)).size;
        } catch {
          // A concurrent cleanup may have removed the file.
        }
      }
    }
    return total;
  }

  function cleanup() {
    const threshold = Date.now() - RETENTION_MS;
    const expired = orders.filter((order) => {
      if (!['done', 'cancelled'].includes(order.status)) return false;
      return Date.parse(order.updatedAt || order.createdAt) < threshold;
    });
    if (!expired.length && orders.length <= MAX_ORDERS) return;

    const removeIds = new Set(expired.map((order) => order.id));
    if (orders.length - removeIds.size > MAX_ORDERS) {
      const oldest = [...orders]
        .sort((first, second) => first.updatedAt.localeCompare(second.updatedAt))
        .slice(0, orders.length - removeIds.size - MAX_ORDERS);
      oldest.forEach((order) => removeIds.add(order.id));
    }
    orders = orders.filter((order) => !removeIds.has(order.id));
    for (const id of removeIds) {
      rmSync(join(filesRoot, id), { recursive: true, force: true });
    }
    persist();
  }

  function createOrder(input, source = 'manual') {
    cleanup();
    const now = new Date().toISOString();
    const sourceFingerprint = cleanText(input.sourceFingerprint, 160);
    const conversationKey = cleanText(input.conversationKey, 160);

    if (sourceFingerprint) {
      const duplicate = orders.find((order) => order.sourceFingerprint === sourceFingerprint);
      if (duplicate) return { order: publicOrder(duplicate), duplicate: true };
    }

    if (source === 'xianyu' && conversationKey) {
      const active = orders.find((order) => (
        order.source === 'xianyu'
        && order.conversationKey === conversationKey
        && !['done', 'cancelled'].includes(order.status)
        && Date.now() - Date.parse(order.updatedAt) < DAY_MS
      ));
      if (active) {
        active.requestText = cleanText(input.requestText, 10000) || active.requestText;
        active.customerName = cleanText(input.customerName, 80) || active.customerName;
        active.title = cleanText(input.title, 120) || active.title;
        active.imageUrls = cleanImageUrls(input.imageUrls);
        active.sourceFingerprint = sourceFingerprint || active.sourceFingerprint;
        active.updatedAt = now;
        active.lastSeenAt = now;
        persist();
        broadcast('order-updated', active);
        return { order: publicOrder(active), duplicate: false, updated: true };
      }
    }

    const order = {
      id: randomUUID(),
      source: source === 'xianyu' ? 'xianyu' : 'manual',
      conversationKey,
      customerName: cleanText(input.customerName, 80),
      title: cleanText(input.title, 120) || '新图片订单',
      requestText: cleanText(input.requestText, 10000),
      imageUrls: cleanImageUrls(input.imageUrls),
      sourceFingerprint,
      status: cleanStatus(input.status),
      quote: cleanText(input.quote, 80),
      draftReply: cleanText(input.draftReply, 4000),
      notes: cleanText(input.notes, 4000),
      files: [],
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now
    };
    orders.unshift(order);
    persist();
    audit('order_created', { orderId: order.id, source: order.source });
    broadcast('order-created', order);
    return { order: publicOrder(order), duplicate: false, updated: false };
  }

  function listOrders() {
    cleanup();
    return orders
      .map(publicOrder)
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  }

  function getOrder(id) {
    const order = orders.find((candidate) => candidate.id === id);
    return order ? publicOrder(order) : null;
  }

  function updateOrder(id, patch) {
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) return null;
    if (Object.hasOwn(patch, 'status')) order.status = cleanStatus(patch.status);
    if (Object.hasOwn(patch, 'title')) order.title = cleanText(patch.title, 120) || order.title;
    if (Object.hasOwn(patch, 'customerName')) order.customerName = cleanText(patch.customerName, 80);
    if (Object.hasOwn(patch, 'requestText')) order.requestText = cleanText(patch.requestText, 10000);
    if (Object.hasOwn(patch, 'quote')) order.quote = cleanText(patch.quote, 80);
    if (Object.hasOwn(patch, 'draftReply')) order.draftReply = cleanText(patch.draftReply, 4000);
    if (Object.hasOwn(patch, 'notes')) order.notes = cleanText(patch.notes, 4000);
    order.updatedAt = new Date().toISOString();
    persist();
    audit('order_updated', { orderId: order.id, status: order.status });
    broadcast('order-updated', order);
    return publicOrder(order);
  }

  function deleteOrder(id) {
    const index = orders.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    const [order] = orders.splice(index, 1);
    rmSync(join(filesRoot, id), { recursive: true, force: true });
    persist();
    audit('order_deleted', { orderId: id });
    broadcast('order-deleted', order);
    return true;
  }

  function addFile(id, bytes, metadata = {}) {
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) return { error: 'not_found' };
    if ((order.files || []).length >= MAX_FILES_PER_ORDER) return { error: 'file_limit' };
    if (storageBytes() + bytes.length > MAX_ORDER_STORAGE_BYTES) return { error: 'storage_limit' };

    const contentType = cleanText(metadata.contentType, 120).toLowerCase() || 'application/octet-stream';
    const originalName = safeFileName(metadata.name, `file${mimeExtension(contentType)}`);
    const expectedExtension = mimeExtension(contentType);
    const currentExtension = extname(originalName).toLowerCase();
    const storedName = `${randomUUID()}${currentExtension || expectedExtension}`;
    const directory = join(filesRoot, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, storedName);
    writeFileSync(path, bytes, { mode: 0o600 });
    const file = {
      id: randomUUID(),
      name: originalName,
      storedName,
      contentType,
      size: bytes.length,
      kind: cleanText(metadata.kind, 24) === 'result' ? 'result' : 'source',
      createdAt: new Date().toISOString()
    };
    order.files = [...(order.files || []), file];
    order.updatedAt = new Date().toISOString();
    persist();
    audit('order_file_added', { orderId: id, fileId: file.id, bytes: bytes.length, kind: file.kind });
    broadcast('order-updated', order);
    return { file: { ...file }, order: publicOrder(order), path };
  }

  function fileForDownload(orderId, fileId) {
    const order = orders.find((candidate) => candidate.id === orderId);
    const file = order?.files?.find((candidate) => candidate.id === fileId);
    if (!file) return null;
    const path = join(filesRoot, orderId, file.storedName);
    if (!existsSync(path)) return null;
    return { file: { ...file }, path };
  }

  function tokenDigest(rawToken) {
    return createHmac('sha256', tokenSecret).update(rawToken, 'utf8').digest();
  }

  function rotateIngestToken(label = 'Chrome 闲鱼监控') {
    const rawToken = `tj_ingest_${randomBytes(32).toString('base64url')}`;
    const record = {
      version: 1,
      hash: tokenDigest(rawToken).toString('base64url'),
      label: cleanText(label, 80) || 'Chrome 闲鱼监控',
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };
    const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, tokenPath);
    audit('ingest_token_rotated', { label: record.label });
    return { token: rawToken, label: record.label, createdAt: record.createdAt, shownOnce: true };
  }

  function ingestTokenStatus() {
    if (!existsSync(tokenPath)) return { configured: false };
    try {
      const record = JSON.parse(readFileSync(tokenPath, 'utf8'));
      return {
        configured: true,
        label: cleanText(record.label, 80),
        createdAt: record.createdAt || null,
        lastUsedAt: record.lastUsedAt || null
      };
    } catch {
      return { configured: false };
    }
  }

  function verifyIngestToken(rawToken) {
    if (!rawToken || !existsSync(tokenPath)) return false;
    let record;
    try {
      record = JSON.parse(readFileSync(tokenPath, 'utf8'));
    } catch {
      return false;
    }
    const expected = Buffer.from(String(record.hash || ''), 'base64url');
    const supplied = tokenDigest(String(rawToken));
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    const now = new Date().toISOString();
    if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60 * 1000) {
      record.lastUsedAt = now;
      const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, tokenPath);
    }
    return true;
  }

  function addEventListener(response) {
    listeners.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
    return () => listeners.delete(response);
  }

  return {
    addEventListener,
    addFile,
    cleanup,
    createOrder,
    deleteOrder,
    fileForDownload,
    getOrder,
    ingestTokenStatus,
    listOrders,
    rotateIngestToken,
    updateOrder,
    verifyIngestToken
  };
}
