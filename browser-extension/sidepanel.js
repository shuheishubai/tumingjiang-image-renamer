const serverUrl = document.querySelector('#serverUrl');
const ingestToken = document.querySelector('#ingestToken');
const monitoring = document.querySelector('#monitoring');
const statePill = document.querySelector('#statePill');
const connectionMessage = document.querySelector('#connectionMessage');

async function loadSettings() {
  const stored = await chrome.storage.local.get(['serverUrl', 'ingestToken', 'monitoring', 'lastSyncAt', 'lastSyncTitle']);
  serverUrl.value = stored.serverUrl || 'https://82.157.65.90';
  ingestToken.value = stored.ingestToken || '';
  monitoring.checked = Boolean(stored.monitoring);
  setState(Boolean(stored.ingestToken), stored.lastSyncAt, stored.lastSyncTitle);
}

function setState(configured, lastSyncAt, title) {
  if (!configured) {
    statePill.textContent = '未配置';
    return;
  }
  statePill.textContent = monitoring.checked ? '监控中' : '已暂停';
  if (lastSyncAt) {
    connectionMessage.textContent = `最近同步：${title || '图片订单'} · ${new Date(lastSyncAt).toLocaleString('zh-CN')}`;
  }
}

document.querySelector('#saveButton').addEventListener('click', async () => {
  const url = serverUrl.value.trim().replace(/\/+$/, '');
  const token = ingestToken.value.trim();
  if (!/^https:\/\//.test(url)) {
    connectionMessage.textContent = '服务器地址必须使用 HTTPS。';
    return;
  }
  if (!token.startsWith('tj_ingest_')) {
    connectionMessage.textContent = '请粘贴随身接单台生成的完整同步令牌。';
    return;
  }
  await chrome.storage.local.set({ serverUrl: url, ingestToken: token });
  connectionMessage.textContent = '正在测试连接…';
  const result = await chrome.runtime.sendMessage({ type: 'order-monitor:test' });
  if (result?.ok) {
    statePill.textContent = monitoring.checked ? '监控中' : '已连接';
    connectionMessage.textContent = '连接成功。接单台中会出现一条测试订单，可以删除。';
  } else {
    connectionMessage.textContent = result?.error || '连接测试失败。';
  }
});

monitoring.addEventListener('change', async () => {
  await chrome.storage.local.set({ monitoring: monitoring.checked });
  setState(Boolean(ingestToken.value.trim()));
});

document.querySelector('#readNowButton').addEventListener('click', async () => {
  connectionMessage.textContent = '正在读取当前闲鱼会话…';
  const result = await chrome.runtime.sendMessage({ type: 'order-monitor:read-now' });
  connectionMessage.textContent = result?.ok
    ? (result.skipped ? `已检查：${result.skipped}` : '当前会话已经同步到接单台。')
    : (result?.error || '读取失败，请确认闲鱼消息页面已经打开。');
});

document.querySelector('#openDeskButton').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'order-monitor:open-desk' });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastSyncAt || changes.lastSyncTitle) loadSettings();
});

loadSettings();
