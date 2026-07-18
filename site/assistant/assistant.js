(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const messageInput = $('#customerMessage');
  const replyDraft = $('#replyDraft');
  const storageKey = 'photo-order-assistant-cases-v1';
  let latestDecision = null;
  let activeCaseId = '';
  let toastTimer = null;
  let candidateADataUrl = '';
  let candidateBDataUrl = '';

  const examples = {
    报名: '四六级照片要改成 144×192，20KB 以内，浅蓝底，今天晚上要，能做吗？',
    换底: '这张证件照帮我换成红底，头发边缘自然一点，还要压到 200KB 以内。',
    基础: '图片改成 295×413 像素，JPG，大小不要超过 100KB。',
    批量: '我有 36 张照片，要按名单学号加姓名批量改名，排好顺序打成 ZIP。',
    复杂: '头发比较碎，背景也很乱，想精细抠图换衣服再修脸，今天能做好吗？'
  };

  const statuses = {
    need_info: { label: '先补充信息', className: 'need-info' },
    instant: { label: '可以直接接', className: '' },
    review: { label: '先技术复核', className: 'review' },
    reject: { label: '不承接', className: 'reject' }
  };

  const stages = [
    ['need_info', '待补充'],
    ['quoted', '已报价'],
    ['processing', '处理中'],
    ['qc', '待验收'],
    ['completed', '已完成'],
    ['refund', '退款 / 关闭']
  ];

  function flash(text) {
    $('#toast').textContent = text;
    $('#toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2400);
  }

  function includesAny(text, words) {
    return words.some((word) => text.includes(word));
  }

  function countHits(text, words) {
    return words.reduce((count, word) => count + Number(text.includes(word)), 0);
  }

  function extractCount(text) {
    const match = text.match(/(\d{1,3})\s*(?:张|个|份)/);
    return match ? Math.min(999, Number(match[1])) : null;
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function greeting() {
    return '你好，欢迎来到「照片这点小事交给我吧」～新店前20单统一0.99元体验价。别再拿豆包修图反复抽卡了，试试更靠谱的人工一对一：先看原图，能做再下单。可以做改尺寸、压KB、转格式、换底色、报名照、批量改名、ZIP和Word整理。把原图、用途、要求截图和最晚使用时间发来，我马上判断能不能做。';
  }

  function screenRequest(rawText) {
    const started = performance.now();
    const original = rawText.trim();
    const text = original.toLocaleLowerCase();
    const required = [];
    const restrictedObjects = ['身份证', '成绩单', '诊断书', '病历', '发票', '票据', '公章', '证明材料', '毕业证', '学位证', '准考证'];
    const restrictedActions = ['改号码', '改姓名', '改日期', '改分数', '改成绩', '改金额', '改章', '伪造', '造假', 'p一个', '换个人'];
    const restrictedFields = ['姓名', '名字', '号码', '身份证号', '日期', '出生', '分数', '成绩', '金额', '公章', '印章', '内容', '信息'];
    const alterationWords = ['改', '换', '替换', '修改', '伪造', '造假', 'p'];
    const watermarkActions = ['去水印', '消水印', '移除水印', '抹水印'];
    const basic = ['尺寸', '像素', 'px', 'kb', '压缩', '格式', 'jpg', 'jpeg', 'png', 'webp', '改名', '重命名', '旋转', '裁剪'];
    const exam = ['四六级', '教资', '国考', '省考', '法考', '报名照', '考试照片', '报名照片', '一寸', '二寸'];
    const background = ['换底', '底色', '红底', '蓝底', '白底', '抠图', '透明背景'];
    const batch = ['批量', '名单', '排序', '打包', 'zip', 'word', '学号'];
    const complex = ['精修', '发丝', '碎发', '复杂背景', '换衣服', '换发型', '修脸', '瘦脸', '合成', '老照片', '修复', '模糊'];
    const urgency = includesAny(text, ['马上', '立刻', '现在要', '十分钟', '半小时', '很急', '加急', '今晚', '今天']);

    if (!original) {
      return {
        status: 'need_info',
        type: '等待需求',
        summary: '还没有可判断的内容。',
        price: '待确认',
        time: '—',
        next: '粘贴顾客原话',
        required: ['顾客需求'],
        reply: greeting(),
        duration: performance.now() - started
      };
    }

    const explicitlyKeepsContent = includesAny(text, [
      '不修改内容', '不改内容', '不修改上面的任何内容', '只改尺寸', '仅改尺寸',
      '只压缩', '仅压缩', '只改格式', '仅改格式'
    ]);
    const restricted = !explicitlyKeepsContent
      && restrictedObjects.some((object) => text.includes(object))
      && (
        restrictedActions.some((action) => text.includes(action))
        || (
          restrictedFields.some((field) => text.includes(field))
          && alterationWords.some((action) => text.includes(action))
        )
      );
    const unauthorizedWatermark = includesAny(text, watermarkActions)
      && !includesAny(text, ['我自己的', '本人拍的', '有授权', '已授权']);
    if (restricted || unauthorizedWatermark) {
      return {
        status: 'reject',
        type: '受限制的图片修改',
        summary: restricted
          ? '涉及修改证件、证明或票据的关键信息，不能承接。'
          : '未确认版权授权的去水印需求不能承接。',
        price: '不报价',
        time: '—',
        next: '礼貌拒绝',
        required: ['无需索要原图'],
        reply: restricted
          ? '不好意思，这个需求涉及修改证件、证明或票据的关键信息，我这边不能承接。普通照片的尺寸、KB、底色、格式和文件名处理可以正常做。'
          : '不好意思，未确认版权授权的去水印需求我这边不能承接。如果这是你本人拥有版权的图片，可以先提供原始文件或授权说明，再重新判断普通画面清理是否能做。',
        duration: performance.now() - started
      };
    }

    const basicHits = countHits(text, basic);
    const isExam = includesAny(text, exam);
    const isBackground = includesAny(text, background);
    const isBatch = includesAny(text, batch);
    const isComplex = includesAny(text, complex);
    const count = extractCount(text);
    const hasSpecificTask = basicHits > 0 || isExam || isBackground || isBatch || isComplex;
    const hasOfficialRequirements = includesAny(text, ['×', 'x', '像素', 'px', 'kb', '截图', '要求']);
    const hasDeadline = includesAny(text, ['今天', '今晚', '明天', '点前', '截止', '马上', '立刻', '加急', '不急']);

    if (!hasSpecificTask || original.length < 6) {
      return {
        status: 'need_info',
        type: '需求还不明确',
        summary: '顾客没有说清要改什么，先用选项快速收集信息，不要急着报价。',
        price: '待确认',
        time: '补齐后判断',
        next: '索要用途和参数',
        required: ['原图', '用途', '目标参数或截图', '截止时间'],
        reply: '可以的～主要想改哪一项呀？\nA. 尺寸/像素\nB. 压缩到指定KB\nC. 换底色\nD. 报名照按要求制作\nE. 改文件名/格式\nF. 其他（直接描述就行）\n\n麻烦再发原图、用途、要求截图和最晚使用时间，我马上确认能不能做和价格。',
        duration: performance.now() - started
      };
    }

    if (!hasOfficialRequirements && (isExam || (basicHits > 0 && !isBatch))) required.push('官方要求截图或目标参数');
    if (isExam || isBackground || isComplex) required.push('原图');
    if (!hasDeadline) required.push('最晚使用时间');
    if (isBatch) required.push('完整名单和正确命名示例');

    if (isComplex) {
      return {
        status: 'review',
        type: '复杂图片技术复核',
        summary: '自动工具可能无法稳定完成，需要先看原图边缘、清晰度和背景，再决定是否接单。',
        price: '先看原图',
        time: urgency ? '先确认能否加急' : '看原图后估时',
        next: '先看原图，不让顾客先付款',
        required: unique(required),
        reply: `可以先帮你判断，但这类${isBackground ? '发丝/复杂背景处理' : '精细修图'}需要看原图，自动处理不一定能稳定达到效果。请先发原图、想要的最终效果${hasDeadline ? '' : '和最晚使用时间'}，我会尽快做技术复核。确认能做、价格和交付时间后再下单；做不到会直接说明，不让你白付款。`,
        duration: performance.now() - started
      };
    }

    if (isExam || isBackground) {
      const price = '0.99 元';
      const type = isExam ? '报名 / 证件照' : '证件照换底色';
      return {
        status: 'review',
        type,
        summary: isExam
          ? '参数可以按通知制作，但不同批次标准不同；构图和人物边缘必须人工检查。'
          : '可以处理，需先检查头发、耳朵和衣服边缘，避免白边、蓝边和锯齿。',
        price,
        time: urgency ? '在线约 5—15 分钟' : '约 5—15 分钟',
        next: required.length ? '补齐材料后报价' : '检查原图后报价',
        required: unique(required.length ? required : ['确认底色和交付格式']),
        reply: isExam
          ? `可以按本次报名要求制作，试运营价 ${price}/张。${hasOfficialRequirements ? '' : '请把报名页面的照片要求截图一起发来，'}${hasDeadline ? '' : '再告诉我最晚什么时候要。'}我会按截图检查尺寸、KB、格式、底色和构图；不同考试批次标准可能不同，所以先确认后再下单。`
          : `可以换底色，普通纯色背景试运营价 ${price}/张${basicHits > 0 ? '，包含换底、尺寸、KB和格式' : ''}。请先发原图${hasDeadline ? '' : '和最晚使用时间'}，我先检查头发、耳朵和衣服边缘；确认能做和效果范围后再下单。`,
        duration: performance.now() - started
      };
    }

    if (isBatch) {
      const price = count && count <= 10 ? '0.99 元' : '先确认体验范围';
      return {
        status: 'instant',
        type: '批量改名与整理',
        summary: '规则清楚即可承接；正式处理前先用 2—3 张核对命名样例，避免整批返工。',
        price,
        time: count && count <= 50 ? '约 5—15 分钟' : '看数量后估时',
        next: '收名单并确认命名样例',
        required: unique(required),
        reply: `可以做批量改名、排序、ZIP 和 Word 整理。${count ? `你这批约 ${count} 张，` : ''}请发完整名单、一个正确命名示例和最终要 ZIP 还是 Word。开始前我会先用 2—3 张给你核对格式，确认后再处理整批。建议价格 ${price}，规则或数量变化会先说明。`,
        duration: performance.now() - started
      };
    }

    const price = '0.99 元';
    return {
      status: 'instant',
      type: '基础图片处理',
      summary: '属于尺寸、KB、格式或文件名处理，参数明确后可以直接接。',
      price,
      time: urgency ? '在线约 3—5 分钟' : '约 3—5 分钟',
      next: required.length ? '补齐参数后下单' : '确认价格后下单',
      required: unique(required.length ? required : ['确认最终文件名和输出格式']),
      reply: `可以做～这个属于基础处理，建议价格 ${price}/张。${hasOfficialRequirements ? '' : '请把目标尺寸、KB和格式发来，'}${hasDeadline ? '' : '再告诉我最晚什么时候要。'}做好后我会检查像素、文件大小、格式和文件名再发给你；参数做错免费重做。`,
      duration: performance.now() - started
    };
  }

  function renderDecision(decision) {
    latestDecision = decision;
    $('#emptyState').hidden = true;
    $('#decisionContent').hidden = false;
    const status = statuses[decision.status];
    $('#statusBadge').textContent = status.label;
    $('#statusBadge').className = `status-badge ${status.className}`.trim();
    $('#decisionTime').textContent = `本地判断 ${decision.duration.toFixed(1)} ms`;
    $('#decisionTitle').textContent = decision.type;
    $('#decisionSummary').textContent = decision.summary;
    $('#suggestedPrice').textContent = decision.price;
    $('#estimatedTime').textContent = decision.time;
    $('#nextAction').textContent = decision.next;
    $('#requiredList').innerHTML = decision.required.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    replyDraft.value = decision.reply;
    $('#copyReply').disabled = false;
    $('#saveCase').disabled = decision.type === '等待需求';
    $('#startJob').disabled = ['等待需求'].includes(decision.type) || ['need_info', 'reject'].includes(decision.status);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('READ_FAILED'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('INVALID_IMAGE'));
      image.src = dataUrl;
    });
  }

  function dataUrlBytes(dataUrl) {
    const encoded = String(dataUrl).split(',')[1] || '';
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  }

  function targetParameters(text) {
    const dimension = text.match(/(\d{2,4})\s*[x×*]\s*(\d{2,4})/i);
    const maximumKb = text.match(/(?:不超过|小于|以内|压到|控制在|≤)?\s*(\d+(?:\.\d+)?)\s*kb/i);
    let format = '';
    if (/\b(?:jpg|jpeg)\b/i.test(text)) format = 'image/jpeg';
    else if (/\bpng\b/i.test(text)) format = 'image/png';
    else if (/\bwebp\b/i.test(text)) format = 'image/webp';
    return {
      width: dimension ? Number(dimension[1]) : null,
      height: dimension ? Number(dimension[2]) : null,
      maximumKb: maximumKb ? Number(maximumKb[1]) : null,
      format
    };
  }

  function requestedFileName(text) {
    const match = String(text).match(/(?:命名为|改名为|文件名(?:是|为)?|叫做)\s*[“"'《【]?([^，。；;,\n”"》】]{1,60})/i);
    return match ? match[1].trim() : '';
  }

  function workflowPreset(text) {
    const target = targetParameters(text);
    const lower = String(text).toLocaleLowerCase();
    let standard = '';
    if (lower.includes('四六级')) standard = target.maximumKb && target.maximumKb <= 20 ? 'cet20' : 'cet';
    else if (lower.includes('教资') || lower.includes('教师资格')) standard = 'ntce';
    else if (lower.includes('国考') || lower.includes('省考')) standard = 'civil';
    else if (lower.includes('二寸')) standard = 'twoInch';
    else if (lower.includes('一寸')) standard = 'oneInch';

    let background = '';
    if (lower.includes('浅蓝底')) background = '#c8e3f3';
    else if (lower.includes('蓝底')) background = '#3979b8';
    else if (lower.includes('红底')) background = '#c92f35';
    else if (lower.includes('白底')) background = '#ffffff';

    return {
      ...target,
      standard,
      background,
      name: requestedFileName(text)
    };
  }

  function editorUrl(item) {
    const preset = workflowPreset(item.message);
    const params = new URLSearchParams({ job: item.id });
    if (preset.width) params.set('w', String(preset.width));
    if (preset.height) params.set('h', String(preset.height));
    if (preset.maximumKb) params.set('kb', String(preset.maximumKb));
    if (preset.format) params.set('fmt', preset.format.replace('image/', '').replace('jpeg', 'jpg'));
    if (preset.standard) params.set('std', preset.standard);
    if (preset.background) params.set('bg', preset.background);
    if (preset.name) params.set('name', preset.name);
    return `/#${params.toString()}`;
  }

  function deliveryReply(item, inspected = null) {
    const target = targetParameters(item?.message || messageInput.value);
    const checks = [];
    const width = inspected?.width || target.width;
    const height = inspected?.height || target.height;
    if (width && height) checks.push(`${width}×${height}px`);
    if (inspected?.bytes) checks.push(`${(inspected.bytes / 1024).toFixed(1)}KB`);
    else if (target.maximumKb) checks.push(`不超过${target.maximumKb}KB`);
    const format = inspected?.type || target.format;
    if (format) checks.push(String(format).replace('image/', '').toUpperCase().replace('JPEG', 'JPG'));
    const checked = checks.length ? `，已核对 ${checks.join('、')}` : '，已按你发来的要求处理并复核';
    return `已经做好啦${checked}。请先下载并打开确认一下；如果报名页面仍提示不符合，把完整报错截图发给我，我马上按提示免费复核。确认没问题后再点收货就可以～`;
  }

  function showDelivery(item, inspected = null) {
    $('#deliveryDraft').value = deliveryReply(item, inspected);
    $('#deliveryBox').hidden = false;
    $('#deliveryBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderQcResults(results) {
    $('#qcResults').innerHTML = results.map((result) => (
      `<li class="${result.level || ''}"><b>${escapeHtml(result.title)}</b>${result.detail ? `：${escapeHtml(result.detail)}` : ''}</li>`
    )).join('');
  }

  async function inspectCandidate(dataUrl, fileMeta = {}) {
    const image = await loadImage(dataUrl);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      bytes: Number(fileMeta.size || dataUrlBytes(dataUrl)),
      type: String(fileMeta.type || dataUrl.slice(5, dataUrl.indexOf(';')) || ''),
      name: String(fileMeta.name || '')
    };
  }

  async function preciseQc(dataUrl, fileMeta = {}, prefix = '候选 A') {
    const inspected = await inspectCandidate(dataUrl, fileMeta);
    const target = targetParameters(messageInput.value);
    const results = [{
      level: '',
      title: `${prefix} 文件`,
      detail: `${inspected.width}×${inspected.height}px · ${(inspected.bytes / 1024).toFixed(1)}KB · ${inspected.type || '未知格式'}`
    }];
    if (target.width && target.height) {
      const pass = inspected.width === target.width && inspected.height === target.height;
      results.push({
        level: pass ? '' : 'fail',
        title: pass ? '尺寸通过' : '尺寸不符合',
        detail: `要求 ${target.width}×${target.height}px`
      });
    }
    if (target.maximumKb) {
      const actualKb = inspected.bytes / 1024;
      const pass = actualKb <= target.maximumKb;
      results.push({
        level: pass ? '' : 'fail',
        title: pass ? '文件大小通过' : '文件过大',
        detail: `要求不超过 ${target.maximumKb}KB，当前 ${actualKb.toFixed(1)}KB`
      });
    }
    if (target.format) {
      const pass = inspected.type === target.format;
      results.push({
        level: pass ? '' : 'fail',
        title: pass ? '格式通过' : '格式不符合',
        detail: `要求 ${target.format.replace('image/', '').toUpperCase()}`
      });
    }
    if (!target.width && !target.maximumKb && !target.format) {
      results.push({
        level: 'warn',
        title: '没有识别到精确参数',
        detail: '请在上方顾客原话中写明宽×高、KB上限或输出格式'
      });
    }
    return { inspected, results };
  }

  function aiEligible(text) {
    const creative = /(换底|底色|背景|抠图|去除|消除|擦除|发丝|白边|蓝边|光晕|锯齿|修复|清晰|美颜|精修)/;
    const generatedTextRisk = /(文字|汉字|数字|改字|替换字|名单|文档|成绩|身份证|证件号|准考证|证明材料|票据)/;
    const decision = screenRequest(text);
    if (decision.status === 'reject') return { ok: false, reason: '该需求属于不承接范围' };
    if (generatedTextRisk.test(text)) return { ok: false, reason: '文字或证明材料任务不能用生成式图片复核' };
    if (!creative.test(text)) return { ok: false, reason: '这是精确参数任务，程序质检比生成第二张图更可靠' };
    return { ok: true, reason: '' };
  }

  async function compareCandidates(firstUrl, secondUrl) {
    const [first, second] = await Promise.all([loadImage(firstUrl), loadImage(secondUrl)]);
    const size = 128;
    const firstCanvas = document.createElement('canvas');
    const secondCanvas = document.createElement('canvas');
    firstCanvas.width = secondCanvas.width = size;
    firstCanvas.height = secondCanvas.height = size;
    const firstContext = firstCanvas.getContext('2d', { willReadFrequently: true });
    const secondContext = secondCanvas.getContext('2d', { willReadFrequently: true });
    firstContext.drawImage(first, 0, 0, size, size);
    secondContext.drawImage(second, 0, 0, size, size);
    const firstPixels = firstContext.getImageData(0, 0, size, size).data;
    const secondPixels = secondContext.getImageData(0, 0, size, size).data;
    let difference = 0;
    for (let index = 0; index < firstPixels.length; index += 4) {
      difference += Math.abs(firstPixels[index] - secondPixels[index]);
      difference += Math.abs(firstPixels[index + 1] - secondPixels[index + 1]);
      difference += Math.abs(firstPixels[index + 2] - secondPixels[index + 2]);
    }
    return difference / (size * size * 3 * 255);
  }

  async function copyText(text, success) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    flash(success);
  }

  function loadCases() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
    } catch {
      return [];
    }
  }

  function storeCases(cases) {
    localStorage.setItem(storageKey, JSON.stringify(cases.slice(0, 100)));
  }

  function stageOptions(selected) {
    return stages.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
  }

  function relativeTime(iso) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function renderCases() {
    const cases = loadCases();
    if (!cases.length) {
      $('#caseList').innerHTML = '<p class="no-cases">还没有订单。判断需求后点“存入接单板”。</p>';
      return;
    }
    $('#caseList').innerHTML = cases.map((item) => {
      const waitingMinutes = Math.floor((Date.now() - Date.parse(item.createdAt)) / 60000);
      const late = item.stage === 'need_info' && waitingMinutes >= 3;
      return `<article class="case-card" data-case-id="${escapeHtml(item.id)}">
        <div class="case-main">
          <div><i>${escapeHtml(item.id)}</i><b>${escapeHtml(item.type)}</b></div>
          <p title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</p>
        </div>
        <div class="case-actions">
          <select aria-label="订单阶段">${stageOptions(item.stage)}</select>
          ${item.stage === 'qc' || item.stage === 'completed' ? '<button type="button" data-copy-delivery>交付回复</button>' : '<button type="button" data-open-case>去修图</button>'}
          <button type="button" data-delete-case>删除</button>
        </div>
        <div class="case-meta">
          <span>${escapeHtml(item.price)}</span>
          <span>${relativeTime(item.createdAt)}</span>
          ${late ? '<span class="late">已等待超过 3 分钟</span>' : ''}
        </div>
      </article>`;
    }).join('');
  }

  function saveCurrentCase() {
    if (!latestDecision || !messageInput.value.trim() || latestDecision.status === 'reject') return null;
    const cases = loadCases();
    const existing = activeCaseId ? cases.find((item) => item.id === activeCaseId) : null;
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.type = latestDecision.type;
      existing.price = latestDecision.price;
      existing.message = messageInput.value.trim().slice(0, 500);
      existing.reply = replyDraft.value.trim().slice(0, 1000);
      storeCases(cases);
      renderCases();
      flash(`已更新接单板：${existing.id}`);
      return existing;
    }
    const item = {
      id: `P${String(Date.now()).slice(-6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage: latestDecision.status === 'need_info' ? 'need_info' : 'quoted',
      type: latestDecision.type,
      price: latestDecision.price,
      message: messageInput.value.trim().slice(0, 500),
      reply: replyDraft.value.trim().slice(0, 1000)
    };
    cases.unshift(item);
    storeCases(cases);
    activeCaseId = item.id;
    renderCases();
    flash(`已存入接单板：${item.id}`);
    return item;
  }

  function startCurrentJob() {
    const item = saveCurrentCase();
    if (!item || latestDecision?.status === 'need_info') {
      flash('请先补齐顾客需求，再开始处理');
      return;
    }
    item.stage = 'processing';
    item.updatedAt = new Date().toISOString();
    const cases = loadCases();
    const stored = cases.find((entry) => entry.id === item.id);
    if (stored) Object.assign(stored, item);
    storeCases(cases);
    window.location.href = editorUrl(item);
  }

  function exportCases() {
    const cases = loadCases();
    if (!cases.length) {
      flash('接单板还没有记录');
      return;
    }
    const header = ['订单号', '创建时间', '阶段', '类型', '建议价格', '需求摘要'];
    const stageMap = Object.fromEntries(stages);
    const rows = cases.map((item) => [
      item.id,
      item.createdAt,
      stageMap[item.stage] || item.stage,
      item.type,
      item.price,
      item.message
    ]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `接单记录_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('接单记录已导出');
  }

  function analyze() {
    activeCaseId = '';
    renderDecision(screenRequest(messageInput.value));
    $('#decision').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('#pasteRequest').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return flash('剪贴板里没有文字');
      messageInput.value = text.slice(0, 3000);
      analyze();
    } catch {
      messageInput.focus();
      flash('浏览器未允许读取剪贴板，请长按输入框粘贴');
    }
  });
  $('#analyzeRequest').addEventListener('click', analyze);
  $('#clearRequest').addEventListener('click', () => {
    messageInput.value = '';
    replyDraft.value = '';
    latestDecision = null;
    activeCaseId = '';
    $('#emptyState').hidden = false;
    $('#decisionContent').hidden = true;
    $('#copyReply').disabled = true;
    $('#saveCase').disabled = true;
    $('#startJob').disabled = true;
    $('#deliveryBox').hidden = true;
    messageInput.focus();
  });

  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      messageInput.value = examples[button.dataset.example] || '';
      analyze();
    });
  });

  messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') analyze();
  });

  $('#copyReply').addEventListener('click', () => copyText(replyDraft.value, '回复已复制，可以粘贴到闲鱼'));
  $('#copyGreeting').addEventListener('click', () => copyText(greeting(), '首次问候已复制'));
  $('#saveCase').addEventListener('click', saveCurrentCase);
  $('#startJob').addEventListener('click', startCurrentJob);
  $('#copyDelivery').addEventListener('click', () => copyText($('#deliveryDraft').value, '交付回复已复制'));
  $('#exportCases').addEventListener('click', exportCases);
  $('#clearCompleted').addEventListener('click', () => {
    const current = loadCases();
    const remaining = current.filter((item) => !['completed', 'refund'].includes(item.stage));
    if (remaining.length === current.length) {
      flash('没有可清理的已完成记录');
      return;
    }
    storeCases(remaining);
    renderCases();
    flash('已清理完成和关闭的记录');
  });

  $('#caseList').addEventListener('change', (event) => {
    const select = event.target.closest('select');
    if (!select) return;
    const card = select.closest('[data-case-id]');
    const cases = loadCases();
    const item = cases.find((entry) => entry.id === card.dataset.caseId);
    if (!item) return;
    item.stage = select.value;
    item.updatedAt = new Date().toISOString();
    storeCases(cases);
    renderCases();
  });

  $('#caseList').addEventListener('click', (event) => {
    const card = event.target.closest('[data-case-id]');
    if (!card) return;
    const item = loadCases().find((entry) => entry.id === card.dataset.caseId);
    if (!item) return;
    if (event.target.closest('[data-open-case]')) {
      item.stage = 'processing';
      item.updatedAt = new Date().toISOString();
      const cases = loadCases();
      const stored = cases.find((entry) => entry.id === item.id);
      if (stored) Object.assign(stored, item);
      storeCases(cases);
      window.location.href = editorUrl(item);
      return;
    }
    if (event.target.closest('[data-copy-delivery]')) {
      activeCaseId = item.id;
      showDelivery(item);
      return;
    }
    if (event.target.closest('[data-delete-case]')) {
      storeCases(loadCases().filter((entry) => entry.id !== card.dataset.caseId));
      renderCases();
      flash('记录已删除');
    }
  });

  $('#qcFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      event.target.value = '';
      flash('请选择 8MB 以内的 PNG、JPG 或 WebP');
      return;
    }
    try {
      candidateADataUrl = await readFileAsDataUrl(file);
      candidateBDataUrl = '';
      $('#candidateA').src = candidateADataUrl;
      $('#candidateA').hidden = false;
      $('#candidateAEmpty').hidden = true;
      $('#candidateB').hidden = true;
      $('#candidateBEmpty').hidden = false;
      $('#downloadAiCandidate').hidden = true;
      $('#runLocalQc').disabled = false;
      $('#generateAiCandidate').disabled = false;
      renderQcResults([{ level: 'neutral', title: '候选 A 已导入', detail: '先做精确参数质检；画面类需求可再生成候选 B' }]);
    } catch {
      flash('图片读取失败，请重新选择');
    }
  });

  $('#runLocalQc').addEventListener('click', async () => {
    if (!candidateADataUrl) return;
    try {
      const file = $('#qcFile').files?.[0] || {};
      const checked = await preciseQc(candidateADataUrl, file, '候选 A');
      const eligibility = aiEligible(messageInput.value);
      checked.results.push({
        level: eligibility.ok ? 'warn' : 'neutral',
        title: eligibility.ok ? '可生成第二候选' : 'GPT Image 2 已跳过',
        detail: eligibility.ok ? '需先取得顾客上传同意，并由店主最终看图' : eligibility.reason
      });
      renderQcResults(checked.results);
      const item = loadCases().find((entry) => entry.id === activeCaseId) || null;
      showDelivery(item, checked.inspected);
    } catch {
      renderQcResults([{ level: 'fail', title: '质检失败', detail: '图片无法正常解析' }]);
    }
  });

  $('#generateAiCandidate').addEventListener('click', async () => {
    if (!candidateADataUrl) return;
    const eligibility = aiEligible(messageInput.value);
    if (!eligibility.ok) {
      renderQcResults([{ level: 'warn', title: '没有调用 GPT Image 2', detail: eligibility.reason }]);
      return;
    }
    const instruction = $('#aiInstruction').value.trim();
    if (instruction.length < 4) {
      flash('请填写需要复核的画面修改要求');
      return;
    }
    if (!$('#aiConsent').checked) {
      flash('请先确认顾客已同意图片上传至 OpenAI');
      return;
    }
    const button = $('#generateAiCandidate');
    button.disabled = true;
    button.textContent = '正在生成候选 B…';
    renderQcResults([{ level: 'neutral', title: 'GPT Image 2 正在处理', detail: '复杂任务可能需要几十秒，请不要重复点击' }]);
    try {
      const response = await fetch('/api/ai/image-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: candidateADataUrl,
          instruction,
          quality: $('#aiQuality').value,
          consent: true
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.image) throw new Error(payload.error || '生成失败');
      candidateBDataUrl = payload.image;
      $('#candidateB').src = candidateBDataUrl;
      $('#candidateB').hidden = false;
      $('#candidateBEmpty').hidden = true;
      $('#downloadAiCandidate').href = candidateBDataUrl;
      $('#downloadAiCandidate').hidden = false;

      const file = $('#qcFile').files?.[0] || {};
      const [firstQc, secondQc, difference] = await Promise.all([
        preciseQc(candidateADataUrl, file, '候选 A'),
        preciseQc(candidateBDataUrl, { type: 'image/jpeg', name: 'GPT-Image-2-候选.jpg' }, '候选 B'),
        compareCandidates(candidateADataUrl, candidateBDataUrl)
      ]);
      const driftLevel = difference > 0.22 ? 'fail' : difference > 0.10 ? 'warn' : '';
      const driftTitle = difference > 0.22 ? '候选 B 改动过大' : difference > 0.10 ? '候选 B 有明显变化' : '候选 B 改动较轻';
      renderQcResults([
        ...firstQc.results,
        ...secondQc.results,
        {
          level: driftLevel,
          title: driftTitle,
          detail: `整体像素差异 ${(difference * 100).toFixed(1)}%；这不是人脸一致性证明，仍需人工查看边缘、五官和文字`
        },
        {
          level: 'warn',
          title: '禁止自动直发',
          detail: '请选择更自然且参数合格的一张，由店主确认后再发给顾客'
        }
      ]);
    } catch (error) {
      renderQcResults([{ level: 'fail', title: '候选 B 生成失败', detail: String(error.message || error) }]);
    } finally {
      button.disabled = false;
      button.textContent = '生成 AI 候选 B';
    }
  });

  setInterval(renderCases, 60000);
  renderCases();

  const returnParams = new URLSearchParams(window.location.search);
  const returnedJobId = returnParams.get('job') || '';
  if (returnedJobId) {
    const cases = loadCases();
    const item = cases.find((entry) => entry.id === returnedJobId);
    if (item) {
      activeCaseId = item.id;
      messageInput.value = item.message;
      renderDecision(screenRequest(item.message));
      if (returnParams.get('done') === '1') {
        item.stage = 'qc';
        item.updatedAt = new Date().toISOString();
        storeCases(cases);
        renderCases();
        showDelivery(item);
        flash(`订单 ${item.id} 已进入待验收`);
      }
    }
  }
})();
