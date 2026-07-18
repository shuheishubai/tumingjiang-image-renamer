const state = {
  orders: [],
  selectedId: null,
  chats: new Map(),
  eventSource: null,
  installPrompt: null,
  seenOrderIds: new Set()
};

const orderList = document.querySelector('#orderList');
const orderDetail = document.querySelector('#orderDetail');
const orderCount = document.querySelector('#orderCount');
const liveDot = document.querySelector('#liveDot');
const liveText = document.querySelector('#liveText');
const lastSync = document.querySelector('#lastSync');
const newOrderDialog = document.querySelector('#newOrderDialog');
const tokenDialog = document.querySelector('#tokenDialog');

const statusNames = {
  new: '新消息',
  triage: '待确认',
  processing: '处理中',
  review: '待检查',
  ready: '待交付',
  done: '已完成',
  cancelled: '不接此单'
};

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    location.href = `/access/?next=${encodeURIComponent('/cloud/')}&owner=1`;
    throw new Error('请重新登录管理员账号');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '操作没有成功');
  return payload;
}

function relativeTime(value) {
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds)) return '';
  if (milliseconds < 60000) return '刚刚';
  if (milliseconds < 3600000) return `${Math.floor(milliseconds / 60000)} 分钟前`;
  if (milliseconds < 86400000) return `${Math.floor(milliseconds / 3600000)} 小时前`;
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setOnline(online) {
  liveDot.classList.toggle('online', online);
  liveText.textContent = online ? '云端订单实时连接中' : '实时连接中断，正在自动重试';
}

function orderSummary(order) {
  return order.requestText || (order.files?.length ? `已收到 ${order.files.length} 个文件` : '等待补充需求');
}

function renderOrders() {
  orderList.replaceChildren();
  orderCount.textContent = `${state.orders.length} 单`;
  if (!state.orders.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-card';
    empty.textContent = '暂时没有新订单。电脑端监控到闲鱼消息后，会自动出现在这里。';
    orderList.append(empty);
    return;
  }
  for (const order of state.orders) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `order-card${order.id === state.selectedId ? ' active' : ''}`;

    const top = document.createElement('div');
    top.className = 'order-card-top';
    const title = document.createElement('strong');
    title.textContent = order.title || order.customerName || '新图片订单';
    const pill = document.createElement('span');
    pill.className = 'status-pill';
    pill.textContent = statusNames[order.status] || '新消息';
    top.append(title, pill);

    const summary = document.createElement('p');
    summary.textContent = orderSummary(order);
    const time = document.createElement('small');
    time.textContent = `${order.source === 'xianyu' ? '闲鱼同步' : '手动记录'} · ${relativeTime(order.updatedAt)}`;
    button.append(top, summary, time);
    button.addEventListener('click', () => selectOrder(order.id));
    orderList.append(button);
  }
}

function makeFileCard(order, file) {
  const link = document.createElement('a');
  link.className = 'file-card';
  link.href = `/api/orders/${order.id}/files/${file.id}`;
  link.target = '_blank';
  link.rel = 'noopener';
  if (String(file.contentType).startsWith('image/')) {
    const image = document.createElement('img');
    image.src = link.href;
    image.alt = file.name;
    link.append(image);
  }
  const name = document.createElement('strong');
  name.textContent = file.name;
  const meta = document.createElement('small');
  meta.textContent = `${file.kind === 'result' ? '交付成品' : '顾客源图'} · ${Math.max(1, Math.round(file.size / 1024))}KB`;
  link.append(name, meta);
  return link;
}

function makeRemoteImageCard(url, index) {
  const link = document.createElement('a');
  link.className = 'file-card';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const name = document.createElement('strong');
  name.textContent = `顾客图片链接 ${index + 1}`;
  const meta = document.createElement('small');
  meta.textContent = '扩展未能缓存原图，点此查看';
  link.append(name, meta);
  return link;
}

function localDraft(order) {
  const text = order.requestText || '';
  const missing = [];
  if (!/(尺寸|像素|\d+\s*[×xX*]\s*\d+)/.test(text)) missing.push('需要的尺寸或像素');
  if (!/(白底|蓝底|红底|背景)/.test(text) && /(证件照|报名照|四六级|国考)/.test(text)) missing.push('背景颜色');
  if (!/(KB|kb|大小|压缩)/.test(text) && /(报名|考试|证件)/.test(text)) missing.push('文件大小上限');
  if (!/(截止|今天|明天|多久|急)/.test(text)) missing.push('交付时间');
  const greeting = order.customerName ? `${order.customerName}，你好～` : '你好～';
  if (missing.length) {
    return `${greeting}需求我看到了。为避免做错，麻烦再确认一下：${missing.join('、')}。确认后我马上处理，做好会先发预览给你检查。`;
  }
  return `${greeting}需求收到，可以处理。做好后我会先检查尺寸、清晰度和边缘效果，再把成品发给你确认；如有细节需要调整，也可以继续告诉我。`;
}

async function patchOrder(orderId, patch, silent = false) {
  const payload = await api(`/api/orders/${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  upsertOrder(payload.order);
  if (!silent) toast('已保存');
  return payload.order;
}

function upsertOrder(order, notify = false) {
  const index = state.orders.findIndex((candidate) => candidate.id === order.id);
  if (index >= 0) state.orders[index] = order;
  else state.orders.unshift(order);
  state.orders.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  renderOrders();
  if (state.selectedId === order.id) renderDetail(order);
  if (notify && !state.seenOrderIds.has(order.id)) {
    state.seenOrderIds.add(order.id);
    showOrderNotification(order);
  }
}

function selectOrder(id) {
  state.selectedId = id;
  const order = state.orders.find((candidate) => candidate.id === id);
  renderOrders();
  if (order) renderDetail(order);
  document.querySelector('.order-rail').classList.add('mobile-hidden');
  orderDetail.classList.add('mobile-open');
}

function renderDetail(order) {
  const fragment = document.querySelector('#detailTemplate').content.cloneNode(true);
  const sourceLine = fragment.querySelector('.source-line');
  sourceLine.textContent = `${order.source === 'xianyu' ? '来自闲鱼电脑监控' : '手动记录'}${order.customerName ? ` · ${order.customerName}` : ''}`;
  fragment.querySelector('.detail-title').textContent = order.title || '新图片订单';
  fragment.querySelector('.detail-time').textContent = `更新于 ${new Date(order.updatedAt).toLocaleString('zh-CN')}`;

  const statusSelect = fragment.querySelector('.status-select');
  statusSelect.value = order.status;
  statusSelect.addEventListener('change', () => patchOrder(order.id, { status: statusSelect.value }));

  const requestEditor = fragment.querySelector('.request-editor');
  requestEditor.value = order.requestText || '';
  fragment.querySelector('.save-request').addEventListener('click', () => patchOrder(order.id, { requestText: requestEditor.value }));

  const fileGrid = fragment.querySelector('.file-grid');
  for (const file of order.files || []) fileGrid.append(makeFileCard(order, file));
  (order.imageUrls || []).forEach((url, index) => fileGrid.append(makeRemoteImageCard(url, index)));
  if (!fileGrid.children.length) {
    const empty = document.createElement('p');
    empty.className = 'safety-note';
    empty.textContent = '还没有图片或交付文件。';
    fileGrid.append(empty);
  }

  const fileInput = fragment.querySelector('.file-input');
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    for (const file of files) {
      try {
        const payload = await api(`/api/orders/${order.id}/files`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
            'X-File-Kind': order.status === 'review' || order.status === 'ready' ? 'result' : 'source'
          },
          body: file
        });
        upsertOrder(payload.order);
      } catch (error) {
        toast(error.message);
        break;
      }
    }
    fileInput.value = '';
    if (files.length) toast('文件已上传');
  });

  const replyEditor = fragment.querySelector('.reply-editor');
  replyEditor.value = order.draftReply || '';
  fragment.querySelector('.quick-draft').addEventListener('click', () => {
    replyEditor.value = localDraft({ ...order, requestText: requestEditor.value });
  });
  fragment.querySelector('.save-reply').addEventListener('click', () => patchOrder(order.id, { draftReply: replyEditor.value }));
  fragment.querySelector('.copy-reply').addEventListener('click', async () => {
    await navigator.clipboard.writeText(replyEditor.value);
    await patchOrder(order.id, { draftReply: replyEditor.value }, true);
    toast('回复已复制，回闲鱼确认后发送');
  });

  const chatLog = fragment.querySelector('.chat-log');
  const history = state.chats.get(order.id) || [];
  for (const entry of history) appendChatBubble(chatLog, entry);
  const consent = fragment.querySelector('.ai-consent');
  consent.checked = localStorage.getItem('order-desk-ai-consent') === 'yes';
  consent.addEventListener('change', () => localStorage.setItem('order-desk-ai-consent', consent.checked ? 'yes' : 'no'));
  const chatInput = fragment.querySelector('.chat-input');
  const chatSend = fragment.querySelector('.chat-send');
  chatSend.addEventListener('click', async () => {
    const message = chatInput.value.trim();
    if (!message) return;
    const chatHistory = state.chats.get(order.id) || [];
    const userEntry = { role: 'user', content: message };
    chatHistory.push(userEntry);
    state.chats.set(order.id, chatHistory);
    appendChatBubble(chatLog, userEntry);
    chatInput.value = '';
    chatSend.disabled = true;
    chatSend.textContent = '思考中…';
    try {
      const payload = await api('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({
          orderId: order.id,
          message,
          consent: consent.checked,
          history: chatHistory.slice(-8, -1)
        })
      });
      const assistantEntry = { role: 'assistant', content: payload.answer };
      chatHistory.push(assistantEntry);
      appendChatBubble(chatLog, assistantEntry);
    } catch (error) {
      toast(error.message);
    } finally {
      chatSend.disabled = false;
      chatSend.textContent = '发送';
    }
  });

  fragment.querySelector('.delete-order').addEventListener('click', async () => {
    if (!confirm('确定删除这条订单及其服务器文件吗？此操作不能撤销。')) return;
    await api(`/api/orders/${order.id}`, { method: 'DELETE' });
    state.orders = state.orders.filter((candidate) => candidate.id !== order.id);
    state.selectedId = null;
    renderOrders();
    orderDetail.innerHTML = '<div class="detail-empty"><span>⌁</span><h2>订单已删除</h2><p>请选择其他订单继续处理。</p></div>';
    document.querySelector('.order-rail').classList.remove('mobile-hidden');
    orderDetail.classList.remove('mobile-open');
  });

  const mobileBack = document.createElement('button');
  mobileBack.type = 'button';
  mobileBack.className = 'paper-button';
  mobileBack.textContent = '← 返回订单';
  mobileBack.addEventListener('click', () => {
    document.querySelector('.order-rail').classList.remove('mobile-hidden');
    orderDetail.classList.remove('mobile-open');
  });

  orderDetail.replaceChildren(mobileBack, fragment);
}

function appendChatBubble(container, entry) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${entry.role === 'assistant' ? 'assistant' : 'user'}`;
  bubble.textContent = entry.content;
  container.append(bubble);
  container.scrollTop = container.scrollHeight;
}

async function loadOrders() {
  try {
    const payload = await api('/api/orders');
    state.orders = payload.orders || [];
    state.seenOrderIds = new Set(state.orders.map((order) => order.id));
    lastSync.textContent = `· ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    renderOrders();
    if (state.selectedId) {
      const selected = state.orders.find((order) => order.id === state.selectedId);
      if (selected) renderDetail(selected);
    }
  } catch (error) {
    setOnline(false);
  }
}

function connectEvents() {
  state.eventSource?.close();
  const events = new EventSource('/api/orders/events');
  state.eventSource = events;
  events.addEventListener('ready', () => setOnline(true));
  events.addEventListener('order-created', (event) => {
    const order = JSON.parse(event.data);
    upsertOrder(order, true);
  });
  events.addEventListener('order-updated', (event) => upsertOrder(JSON.parse(event.data)));
  events.addEventListener('order-deleted', (event) => {
    const deleted = JSON.parse(event.data);
    state.orders = state.orders.filter((order) => order.id !== deleted.id);
    if (state.selectedId === deleted.id) state.selectedId = null;
    renderOrders();
  });
  events.onerror = () => setOnline(false);
}

function showOrderNotification(order) {
  if (document.visibilityState === 'visible') {
    toast(`新订单：${order.title || order.customerName || '图片需求'}`);
  }
  if (Notification.permission !== 'granted') return;
  const notification = new Notification('收到新的图片订单', {
    body: `${order.customerName || '闲鱼顾客'}：${orderSummary(order).slice(0, 80)}`,
    tag: `order-${order.id}`
  });
  notification.onclick = () => {
    window.focus();
    selectOrder(order.id);
    notification.close();
  };
}

document.querySelector('#refreshButton').addEventListener('click', loadOrders);
document.querySelector('#newOrderButton').addEventListener('click', () => newOrderDialog.showModal());
document.querySelector('#newOrderForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const payload = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    newOrderDialog.close();
    event.currentTarget.reset();
    upsertOrder(payload.order);
    selectOrder(payload.order.id);
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector('#notifyButton').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('当前浏览器不支持系统通知');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? '新订单提醒已打开' : '没有获得通知权限');
});

document.querySelector('#tokenButton').addEventListener('click', async () => {
  tokenDialog.showModal();
  try {
    const status = await api('/api/access/ingest-token');
    document.querySelector('#tokenStatus').textContent = status.configured
      ? `令牌已配置：${status.label || '电脑监控'}${status.lastUsedAt ? `，最近同步 ${relativeTime(status.lastUsedAt)}` : '，尚未使用'}`
      : '还没有生成电脑同步令牌。';
  } catch (error) {
    document.querySelector('#tokenStatus').textContent = error.message;
  }
});
document.querySelector('#closeTokenDialog').addEventListener('click', () => tokenDialog.close());
document.querySelector('#rotateTokenButton').addEventListener('click', async () => {
  if (!confirm('生成新令牌后，旧的 Chrome 扩展令牌会立即失效。继续吗？')) return;
  try {
    const payload = await api('/api/access/ingest-token', {
      method: 'POST',
      body: JSON.stringify({ label: 'Chrome 闲鱼监控' })
    });
    document.querySelector('#tokenValue').value = payload.token;
    document.querySelector('#tokenResult').hidden = false;
    document.querySelector('#tokenStatus').textContent = '新令牌已生成。关闭弹窗后，服务器不会再显示完整令牌。';
  } catch (error) {
    toast(error.message);
  }
});
document.querySelector('#copyTokenButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.querySelector('#tokenValue').value);
  toast('同步令牌已复制');
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  document.querySelector('#installButton').hidden = false;
});
document.querySelector('#installButton').addEventListener('click', async () => {
  if (!state.installPrompt) return;
  await state.installPrompt.prompt();
  state.installPrompt = null;
  document.querySelector('#installButton').hidden = true;
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
loadOrders().then(connectEvents);
setInterval(loadOrders, 60000);
