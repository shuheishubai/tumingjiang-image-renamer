const DEFAULT_SERVER = 'https://82.157.65.90';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create('xianyu-monitor-heartbeat', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'xianyu-monitor-heartbeat') return;
  const settings = await chrome.storage.local.get(['monitoring']);
  if (!settings.monitoring) return;
  const tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/im*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'order-monitor:heartbeat' }).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('order:')) return;
  const { serverUrl = DEFAULT_SERVER } = await chrome.storage.local.get(['serverUrl']);
  await chrome.tabs.create({ url: `${serverUrl}/cloud/` });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'order-monitor:snapshot') {
    forwardSnapshot(message.payload, sender.tab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'order-monitor:test') {
    testConnection()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'order-monitor:read-now') {
    readCurrentConversation()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'order-monitor:open-desk') {
    openDesk().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function settings() {
  const stored = await chrome.storage.local.get(['serverUrl', 'ingestToken', 'monitoring', 'uploadedUrls']);
  return {
    serverUrl: String(stored.serverUrl || DEFAULT_SERVER).replace(/\/+$/, ''),
    ingestToken: String(stored.ingestToken || ''),
    monitoring: Boolean(stored.monitoring),
    uploadedUrls: stored.uploadedUrls && typeof stored.uploadedUrls === 'object' ? stored.uploadedUrls : {}
  };
}

async function testConnection() {
  const current = await settings();
  if (!current.ingestToken) throw new Error('请先粘贴同步令牌');
  const response = await fetch(`${current.serverUrl}/api/ingest/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${current.ingestToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sourceFingerprint: `connection-test-${Date.now()}`,
      conversationKey: 'extension-connection-test',
      customerName: '连接测试',
      title: '扩展连接测试',
      requestText: '这是一条连接测试订单，可以在接单台中删除。'
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `连接失败（${response.status}）`);
  return { orderId: payload.order?.id };
}

async function readCurrentConversation() {
  const tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/im*' });
  const tab = tabs.find((candidate) => candidate.active) || tabs[0];
  if (!tab?.id) throw new Error('请先打开闲鱼网页版消息页面');
  return await chrome.tabs.sendMessage(tab.id, { type: 'order-monitor:read-now' });
}

async function openDesk() {
  const { serverUrl = DEFAULT_SERVER } = await chrome.storage.local.get(['serverUrl']);
  await chrome.tabs.create({ url: `${String(serverUrl).replace(/\/+$/, '')}/cloud/` });
}

async function hashUrl(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

async function forwardSnapshot(payload, tab) {
  const current = await settings();
  if (!current.monitoring && !payload.manual) return { skipped: 'monitoring-disabled' };
  if (!current.ingestToken) throw new Error('接单监控尚未配置同步令牌');
  if (!payload.requestText || payload.requestText.length < 2) return { skipped: 'empty-conversation' };

  const response = await fetch(`${current.serverUrl}/api/ingest/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${current.ingestToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      conversationKey: payload.conversationKey,
      customerName: payload.customerName,
      title: payload.title,
      requestText: payload.requestText,
      imageUrls: payload.imageUrls,
      sourceFingerprint: payload.fingerprint
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `订单同步失败（${response.status}）`);
  const order = result.order;
  if (!order?.id) throw new Error('服务器没有返回订单编号');

  if (!result.duplicate) {
    for (const url of (payload.imageUrls || []).slice(0, 8)) {
      try {
        const urlHash = await hashUrl(url);
        if (current.uploadedUrls[urlHash]) continue;
        const imageResponse = await fetch(url, { credentials: 'include' });
        if (!imageResponse.ok) continue;
        const blob = await imageResponse.blob();
        if (!blob.type.startsWith('image/') || blob.size <= 0 || blob.size > 10 * 1024 * 1024) continue;
        const name = new URL(url).pathname.split('/').pop() || `customer-image-${Date.now()}.jpg`;
        const uploadResponse = await fetch(`${current.serverUrl}/api/ingest/orders/${order.id}/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${current.ingestToken}`,
            'Content-Type': blob.type,
            'X-File-Name': encodeURIComponent(name),
            'X-File-Kind': 'source'
          },
          body: blob
        });
        if (uploadResponse.ok) current.uploadedUrls[urlHash] = Date.now();
      } catch {
        // The order remains useful even when a protected image CDN blocks the fetch.
      }
    }
  }

  const trimmedUploads = Object.fromEntries(
    Object.entries(current.uploadedUrls)
      .sort((first, second) => second[1] - first[1])
      .slice(0, 300)
  );
  await chrome.storage.local.set({
    uploadedUrls: trimmedUploads,
    lastSyncAt: Date.now(),
    lastSyncTitle: order.title || payload.title
  });
  await chrome.notifications.create(`order:${order.id}`, {
    type: 'basic',
    iconUrl: 'notify.svg',
    title: result.updated ? '顾客补充了新消息' : '收到新的闲鱼图片订单',
    message: `${payload.customerName || '闲鱼顾客'}：${payload.requestText.slice(0, 90)}`
  }).catch(() => {});
  return { orderId: order.id, duplicate: result.duplicate, updated: result.updated, tabId: tab?.id };
}
