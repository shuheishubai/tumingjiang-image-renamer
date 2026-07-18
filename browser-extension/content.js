let baselineFingerprint = '';
let lastSentFingerprint = '';
let timer = null;
let scanning = false;

function visible(element) {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 80 && box.height > 24;
}

function conversationRoot() {
  const candidates = [
    ...document.querySelectorAll('main, [class*="message"], [class*="Message"], [class*="conversation"], [class*="Conversation"], [class*="chat"], [class*="Chat"]')
  ].filter(visible);
  candidates.sort((first, second) => {
    const firstScore = Math.min(first.innerText?.length || 0, 10000) + first.getBoundingClientRect().height;
    const secondScore = Math.min(second.innerText?.length || 0, 10000) + second.getBoundingClientRect().height;
    return secondScore - firstScore;
  });
  return candidates[0] || document.body;
}

function compactText(root) {
  return String(root.innerText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(消息|卖东西|我的|首页|发布闲置|下载APP)$/.test(line))
    .join('\n')
    .slice(-10000);
}

function imageUrls(root) {
  const urls = [];
  for (const image of root.querySelectorAll('img')) {
    const box = image.getBoundingClientRect();
    const src = String(image.currentSrc || image.src || '');
    if (box.width < 72 || box.height < 72 || !/^https?:\/\//.test(src)) continue;
    urls.push(src);
  }
  return [...new Set(urls)].slice(0, 12);
}

function selectedCustomerName() {
  const selectors = [
    '[aria-selected="true"]',
    '[class*="active"] [class*="name"]',
    '[class*="selected"] [class*="name"]',
    'header h1',
    'header h2'
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const value = String(node?.textContent || '').trim();
    if (value && value.length <= 80 && !/闲鱼|消息/.test(value)) return value;
  }
  return '';
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

async function snapshot(manual = false) {
  if (scanning) return { ok: false, skipped: 'busy' };
  scanning = true;
  try {
    const root = conversationRoot();
    const requestText = compactText(root);
    const images = imageUrls(root);
    if (requestText.length < 2 && !images.length) return { ok: false, skipped: 'empty' };
    const customerName = selectedCustomerName();
    const conversationKey = await fingerprint(`${location.pathname}|${customerName}|${requestText.slice(0, 300)}`);
    const currentFingerprint = await fingerprint(`${requestText}|${images.join('|')}`);
    if (!baselineFingerprint) {
      baselineFingerprint = currentFingerprint;
      if (!manual) return { ok: true, skipped: 'baseline-recorded' };
    }
    if (!manual && currentFingerprint === lastSentFingerprint) return { ok: true, skipped: 'unchanged' };
    lastSentFingerprint = currentFingerprint;
    const result = await chrome.runtime.sendMessage({
      type: 'order-monitor:snapshot',
      payload: {
        manual,
        conversationKey,
        customerName,
        title: customerName ? `${customerName}的图片需求` : '闲鱼图片订单',
        requestText,
        imageUrls: images,
        fingerprint: currentFingerprint
      }
    });
    return result || { ok: false, error: '扩展后台没有响应' };
  } finally {
    scanning = false;
  }
}

function scheduleSnapshot() {
  clearTimeout(timer);
  timer = setTimeout(() => snapshot(false).catch(() => {}), 1800);
}

const observer = new MutationObserver(scheduleSnapshot);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
setTimeout(() => snapshot(false).catch(() => {}), 2500);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'order-monitor:read-now') {
    snapshot(true).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'order-monitor:heartbeat') {
    snapshot(false).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
