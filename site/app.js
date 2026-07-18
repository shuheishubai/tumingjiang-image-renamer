import { FaceDetector, FilesetResolver, ImageSegmenter } from './vendor/mediapipe/vision_bundle.mjs';
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';

const $ = (selector) => document.querySelector(selector);
const photoPicker = $('#photoPicker');
const dropZone = $('#dropZone');
const photoList = $('#photoList');
const editorCanvas = $('#editorCanvas');
const editorContext = editorCanvas.getContext('2d');
const previewCanvas = $('#previewCanvas');
const textEditCanvas = $('#textEditCanvas');
const removeEditCanvas = $('#removeEditCanvas');
const MAX_PHOTOS = 50;
const imageExtensions = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
const isMobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || window.matchMedia?.('(pointer: coarse)').matches;

function readDeskPreset() {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(raw);
  const job = (params.get('job') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!job) return null;
  const number = (key, max) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) && value > 0 && value <= max ? Math.round(value) : 0;
  };
  const format = ['jpg', 'png', 'webp'].includes(params.get('fmt')) ? params.get('fmt') : '';
  const standard = ['cet', 'cet20', 'ntce', 'civil', 'oneInch', 'twoInch'].includes(params.get('std')) ? params.get('std') : '';
  const background = /^#[0-9a-f]{6}$/i.test(params.get('bg') || '') ? params.get('bg') : '';
  return {
    job,
    width: number('w', 10000),
    height: number('h', 10000),
    maximumKb: number('kb', 50000),
    format,
    standard,
    background,
    name: String(params.get('name') || '').slice(0, 80)
  };
}

const deskPreset = readDeskPreset();
let deskPresetApplied = false;

let photos = [];
let toastTimer;
let segmenterPromise;
let faceDetectorPromise;
let backgroundImage = null;
let backgroundUrl = '';
let customBackgroundActive = false;
let renderToken = 0;
let previewMetrics = null;
let dragging = null;
let brushDrawing = false;
let brushMode = 'move';
let restoringHistory = false;
let history = [];
let historyIndex = -1;
let defaultSnapshot = null;
let quickPreviewTimer;
let quickPreviewToken = 0;
let quickPreviewOriginalCanvas = null;
let quickPreviewResultCanvas = null;
let pendingEffectReveal = '';
let ocrWorkerPromise;
let activeTextPhotoId = null;
let textEditorOriginal = null;
let textSelection = null;
let textSelectionStart = null;
let matchedTextStyle = null;
let recognizedSourceText = '';
let activeRemovePhotoId = null;
let removeEditorOriginal = null;
let removeSelection = null;
let removeSelectionStart = null;
let saveTrayEntries = [];
let saveTrayUrls = [];
let saveTrayZip = null;
let saveTrayTemporaryUrl = '';
const personState = { scale: 1, x: 0, y: 0 };
const photoStandardState = { id: '', topRatio: null, sideRatio: null };
const transformState = { rotation: 0, flipHorizontal: false };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function cleanName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || '未命名';
}

function fileStem(name) {
  const dot = name.lastIndexOf('.');
  return cleanName(dot > 0 ? name.slice(0, dot) : name);
}

function fileExtension(file) {
  const dot = file.name.lastIndexOf('.');
  return (dot >= 0 ? file.name.slice(dot + 1) : 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
}

function isImage(file) {
  return file.type.startsWith('image/') || imageExtensions.test(file.name);
}

function flash(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法读取'));
    image.src = url;
  });
}

function currentBackground() {
  if (backgroundImage) return { type: 'image', image: backgroundImage };
  if (customBackgroundActive) return { type: 'color', value: $('#customBgColor').value };
  const checked = document.querySelector('input[name="personBg"]:checked');
  return { type: checked?.value === 'transparent' ? 'transparent' : 'color', value: checked?.value || '#2878d0' };
}

function outputExtension(photo) {
  const format = $('#outputFormat').value;
  if ($('#personEnabled').checked && currentBackground().type === 'transparent') return 'png';
  if (format === 'jpeg') return 'jpg';
  if (format === 'png' || format === 'webp') return format;
  if ($('#personEnabled').checked) return 'jpg';
  return hasImageEdits() ? 'jpg' : photo.ext;
}

function hasImageEdits() {
  const adjusted = ['brightness', 'contrast', 'saturation', 'vibrance', 'warmth', 'tint', 'highlights', 'shadows', 'fade', 'vignette', 'sharpen', 'shadowTeal', 'highlightWarm', 'filmGrain', 'clarityAmount']
    .some((id) => Number($(`#${id}`).value) !== 0);
  return $('#resizeEnabled').checked
    || $('#personEnabled').checked
    || $('#cropRatio').value !== 'original'
    || transformState.rotation !== 0
    || transformState.flipHorizontal
    || adjusted
    || Number($('#beautyAmount').value) > 0
    || Boolean($('#watermarkText').value.trim())
    || $('#mosaicEnabled').checked
    || photos.some((photo) => photo.textEdits?.length)
    || photos.some((photo) => photo.removals?.length)
    || $('#outputFormat').value !== 'auto'
    || Number($('#outputQuality').value) !== 92
    || Number($('#targetKB').value) > 0;
}

function resolvedNames() {
  const used = new Map();
  return photos.map((photo) => {
    const base = cleanName(photo.name);
    const ext = outputExtension(photo);
    const key = `${base}.${ext}`.toLocaleLowerCase();
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    return `${base}${count > 1 ? `_${count}` : ''}.${ext}`;
  });
}

function refreshResolvedNames() {
  const names = resolvedNames();
  document.querySelectorAll('[data-final-name]').forEach((node) => {
    const index = Number(node.dataset.finalName);
    node.textContent = names[index] || '';
    node.title = names[index] || '';
  });
}

function renderPhotos() {
  const hasPhotos = photos.length > 0;
  $('#selectionHead').classList.toggle('show', hasPhotos);
  $('#photoCount').textContent = photos.length;
  $('#downloadZip').disabled = !hasPhotos;
  $('#downloadFiles').disabled = !hasPhotos;
  $('#downloadWord').disabled = !hasPhotos;
  $('#personEnabled').disabled = !hasPhotos;
  $('#openTextEditor').disabled = !hasPhotos;
  $('#openRemoveEditor').disabled = !hasPhotos;
  photoList.innerHTML = photos.map((photo, index) => `<article class="photo-row" data-id="${photo.id}">
    <img src="${photo.url}" alt="${esc(photo.name)}的预览">
    <div class="rename">
      <label>想把这张图片叫做</label>
      <div class="name-line"><input data-name value="${esc(photo.name)}" maxlength="80" aria-label="第${index + 1}张图片的新名称"><span>.${esc(outputExtension(photo))}</span></div>
      <span class="final-name" data-final-name="${index}"></span>
    </div>
    <div class="row-actions">
      <button data-text type="button">改文字</button>
      <button data-remove-content type="button">去除</button>
      <button class="one-download" data-one type="button">单独下载</button>
      <button class="remove" data-remove type="button" aria-label="移除第${index + 1}张图片">×</button>
    </div>
  </article>`).join('');
  refreshResolvedNames();
  if ($('#personEnabled').checked) scheduleEditorRender();
  scheduleQuickPreview();
}

function addPhotos(fileList) {
  const valid = [...fileList].filter(isImage);
  const accepted = valid.slice(0, Math.max(0, MAX_PHOTOS - photos.length));
  accepted.forEach((file) => {
    const url = URL.createObjectURL(file);
    photos.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: fileStem(file.name),
      ext: fileExtension(file),
      url,
      imagePromise: imageFromUrl(url),
      cutout: null,
      segmentData: null,
      textEdits: [],
      removals: []
    });
  });
  renderPhotos();
  if (accepted.length) applyDeskPreset();
  if (valid.length > accepted.length) flash(`一次最多处理 ${MAX_PHOTOS} 张，已忽略多余图片`);
  else if (accepted.length) {
    if (!deskPreset) flash(`已添加 ${accepted.length} 张图片`);
  } else flash('请选择图片文件');
}

photoPicker.addEventListener('change', () => {
  addPhotos(photoPicker.files);
  photoPicker.value = '';
});

$('#cameraPicker').addEventListener('change', () => {
  addPhotos($('#cameraPicker').files);
  $('#cameraPicker').value = '';
});

['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add('drag');
}));

['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag');
}));

dropZone.addEventListener('drop', (event) => addPhotos(event.dataTransfer.files));

photoList.addEventListener('input', (event) => {
  const input = event.target.closest('[data-name]');
  if (!input) return;
  const photo = photos.find((item) => item.id === input.closest('.photo-row').dataset.id);
  if (photo) photo.name = input.value;
  refreshResolvedNames();
});

photoList.addEventListener('click', async (event) => {
  const row = event.target.closest('.photo-row');
  if (!row) return;
  const index = photos.findIndex((item) => item.id === row.dataset.id);
  if (index < 0) return;
  if (event.target.closest('[data-text]')) {
    await openTextEditor(photos[index]);
    return;
  }
  if (event.target.closest('[data-remove-content]')) {
    await openRemoveEditor(photos[index]);
    return;
  }
  if (event.target.closest('[data-remove]')) {
    const [photo] = photos.splice(index, 1);
    URL.revokeObjectURL(photo.url);
    if (photo.id === activeTextPhotoId) closeTextEditor();
    if (photo.id === activeRemovePhotoId) closeRemoveEditor();
    renderPhotos();
  }
  if (event.target.closest('[data-one]')) await downloadOne(index);
});

$('#clearPhotos').addEventListener('click', () => {
  photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  photos = [];
  renderPhotos();
  $('#portraitPanel').hidden = true;
  $('#personEnabled').checked = false;
  editorContext.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  closeTextEditor();
  closeRemoveEditor();
  flash('图片已清空');
});

function setWorkspace(workspace, shouldScroll = true) {
  const target = ['modify', 'color', 'retouch'].includes(workspace) ? workspace : 'modify';
  $('#toolSheet').dataset.activeWorkspace = target;
  document.querySelectorAll('[data-workspace-target]').forEach((button) => {
    button.classList.toggle('active', button.dataset.workspaceTarget === target);
  });
  $('#outputArea').classList.toggle('workspace-hidden', target !== 'modify');
  if (shouldScroll) $('.edit-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelector('.workspace-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-workspace-target]');
  if (button) setWorkspace(button.dataset.workspaceTarget);
});

$('#focusNaming').addEventListener('click', () => {
  if (!photos.length) return flash('请先选择图片');
  photoList.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => photoList.querySelector('[data-name]')?.focus(), 450);
});

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10000 ? number : 0;
}

function outputDimensions(image) {
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  if (!$('#resizeEnabled').checked) return { width: originalWidth, height: originalHeight };
  let width = positiveInt($('#targetWidth').value);
  let height = positiveInt($('#targetHeight').value);
  if (!width && !height) throw new Error('请至少填写宽度或高度');
  if ($('#keepRatio').checked) {
    const ratio = originalWidth / originalHeight;
    if (width && height) {
      const fitted = width / height > ratio
        ? { width: Math.round(height * ratio), height }
        : { width, height: Math.round(width / ratio) };
      width = fitted.width;
      height = fitted.height;
    } else if (width) height = Math.max(1, Math.round(width / ratio));
    else width = Math.max(1, Math.round(height * ratio));
  } else {
    width ||= originalWidth;
    height ||= originalHeight;
  }
  return { width, height };
}

[$('#resizeEnabled'), $('#targetWidth'), $('#targetHeight'), $('#keepRatio')].forEach((control) => {
  control.addEventListener('input', () => {
    refreshResolvedNames();
    if ($('#personEnabled').checked) scheduleEditorRender();
  });
});

const settingIds = [
  'cropRatio', 'cropX', 'cropY', 'resizeEnabled', 'targetWidth', 'targetHeight', 'keepRatio',
  'brightness', 'contrast', 'saturation', 'vibrance', 'warmth', 'tint', 'highlights', 'shadows',
  'fade', 'vignette', 'sharpen', 'shadowTeal', 'highlightWarm', 'filmGrain', 'clarityAmount', 'beautyAmount', 'personEnabled', 'edgeRefine',
  'personScale', 'brushSize', 'watermarkText', 'watermarkPosition', 'watermarkSize',
  'watermarkOpacity', 'watermarkColor', 'mosaicEnabled', 'mosaicX', 'mosaicY', 'mosaicWidth',
  'mosaicHeight', 'mosaicStrength', 'outputFormat', 'outputQuality', 'targetKB'
];

function settingsSnapshot() {
  const controls = {};
  settingIds.forEach((id) => {
    const element = $(`#${id}`);
    controls[id] = element.type === 'checkbox' ? element.checked : element.value;
  });
  return {
    controls,
    rotation: transformState.rotation,
    flipHorizontal: transformState.flipHorizontal,
    person: { ...personState },
    photoStandard: { ...photoStandardState },
    background: document.querySelector('input[name="personBg"]:checked')?.value || '#3979b8'
  };
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateHistoryButtons() {
  $('#undoEdit').disabled = historyIndex <= 0;
  $('#redoEdit').disabled = historyIndex < 0 || historyIndex >= history.length - 1;
}

function checkpointHistory() {
  if (restoringHistory) return;
  const snapshot = settingsSnapshot();
  if (historyIndex >= 0 && snapshotsEqual(snapshot, history[historyIndex])) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  if (history.length > 40) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function syncControlLabels() {
  ['brightness', 'contrast', 'saturation', 'vibrance', 'warmth', 'tint', 'highlights', 'shadows', 'fade', 'vignette', 'sharpen'].forEach((id) => {
    $(`#${id}`).closest('label').querySelector('output').textContent = $(`#${id}`).value;
  });
  $('#qualityValue').textContent = `${$('#outputQuality').value}%`;
  $('#brushValue').textContent = $('#brushSize').value;
  $('#scaleValue').textContent = `${$('#personScale').value}%`;
}

function syncEffectReceipt(reveal = '') {
  const clarityEnabled = Number($('#clarityAmount').value) > 0;
  const beautyEnabled = Number($('#beautyAmount').value) > 0;
  const enabled = clarityEnabled || beautyEnabled;
  const labels = [clarityEnabled ? '清晰增强' : '', beautyEnabled ? '清颜优化' : ''].filter(Boolean);
  $('#effectReceipt').classList.toggle('active', enabled);
  $('#effectReceipt').querySelector('b').textContent = enabled ? `${labels.join('＋')}已生效` : '效果回执';
  $('#effectReceipt').querySelector('small').textContent = enabled
    ? '到上方预览按住“看原图”，松开立即比较效果'
    : '开启后，可在上方预览按住比较原图';
  if (reveal && enabled) pendingEffectReveal = reveal;
}

function restoreSnapshot(snapshot) {
  restoringHistory = true;
  Object.entries(snapshot.controls).forEach(([id, value]) => {
    const element = $(`#${id}`);
    if (element.type === 'checkbox') element.checked = value;
    else element.value = value;
  });
  transformState.rotation = snapshot.rotation;
  transformState.flipHorizontal = snapshot.flipHorizontal;
  Object.assign(personState, snapshot.person);
  Object.assign(photoStandardState, snapshot.photoStandard || { id: '', topRatio: null, sideRatio: null });
  const background = [...document.querySelectorAll('input[name="personBg"]')].find((input) => input.value === snapshot.background);
  if (background) background.checked = true;
  syncPhotoStandardUi();
  $('#softBeauty').classList.toggle('active', Number($('#beautyAmount').value) > 0);
  document.querySelectorAll('[data-clarity]').forEach((button) => button.classList.toggle('active', Number($('#clarityAmount').value) > 0));
  syncEffectReceipt();
  $('#portraitPanel').hidden = !$('#personEnabled').checked;
  $('#flipHorizontal').classList.toggle('active', transformState.flipHorizontal);
  syncControlLabels();
  photos.forEach((photo) => { photo.cutout = null; });
  refreshResolvedNames();
  if ($('#personEnabled').checked) scheduleEditorRender();
  scheduleQuickPreview();
  restoringHistory = false;
  updateHistoryButtons();
}

function useHistory(index) {
  if (index < 0 || index >= history.length) return;
  historyIndex = index;
  restoreSnapshot(history[historyIndex]);
}

$('#undoEdit').addEventListener('click', () => useHistory(historyIndex - 1));
$('#redoEdit').addEventListener('click', () => useHistory(historyIndex + 1));

$('#rotateLeft').addEventListener('click', () => {
  transformState.rotation = (transformState.rotation - 90 + 360) % 360;
  checkpointHistory();
  scheduleQuickPreview();
  flash('已向左旋转 90°');
});

$('#rotateRight').addEventListener('click', () => {
  transformState.rotation = (transformState.rotation + 90) % 360;
  checkpointHistory();
  scheduleQuickPreview();
  flash('已向右旋转 90°');
});

$('#flipHorizontal').addEventListener('click', () => {
  transformState.flipHorizontal = !transformState.flipHorizontal;
  $('#flipHorizontal').classList.toggle('active', transformState.flipHorizontal);
  checkpointHistory();
  scheduleQuickPreview();
});

$('#autoEnhance').addEventListener('click', () => {
  $('#brightness').value = 5;
  $('#contrast').value = 7;
  $('#saturation').value = 5;
  $('#vibrance').value = 8;
  $('#warmth').value = 2;
  $('#tint').value = 0;
  $('#highlights').value = -5;
  $('#shadows').value = 8;
  $('#fade').value = 0;
  $('#vignette').value = 0;
  $('#sharpen').value = 10;
  syncControlLabels();
  checkpointHistory();
  scheduleQuickPreview();
  flash('已应用自然优化，可继续微调');
});

const colorPresets = {
  filmWarm: { name: '暖调胶片', brightness: 2, contrast: 9, saturation: -5, vibrance: 12, warmth: 10, tint: 2, highlights: -13, shadows: 10, fade: 8, vignette: 5, sharpen: 4, shadowTeal: 3, highlightWarm: 10, filmGrain: 7 },
  tealOrange: { name: '青橙电影', brightness: -2, contrast: 17, saturation: -3, vibrance: 10, warmth: -2, tint: 0, highlights: -18, shadows: 7, fade: 3, vignette: 12, sharpen: 7, shadowTeal: 17, highlightWarm: 14, filmGrain: 3 },
  cleanPortrait: { name: '清透人像', brightness: 6, contrast: 3, saturation: -2, vibrance: 11, warmth: 4, tint: 2, highlights: -10, shadows: 16, fade: 1, vignette: 0, sharpen: 6, shadowTeal: 0, highlightWarm: 4, filmGrain: 0 },
  cream: { name: '奶油柔光', brightness: 7, contrast: -7, saturation: -9, vibrance: 5, warmth: 8, tint: 3, highlights: -15, shadows: 20, fade: 13, vignette: 0, sharpen: 1, shadowTeal: -2, highlightWarm: 12, filmGrain: 2 },
  cinema: { name: '冷感电影', brightness: -4, contrast: 19, saturation: -14, vibrance: -3, warmth: -8, tint: 3, highlights: -22, shadows: 5, fade: 5, vignette: 16, sharpen: 6, shadowTeal: 13, highlightWarm: 2, filmGrain: 4 },
  softEmber: { name: '柔焰复古', brightness: 1, contrast: 8, saturation: -12, vibrance: 5, warmth: 15, tint: 5, highlights: -17, shadows: 10, fade: 12, vignette: 8, sharpen: 2, shadowTeal: -5, highlightWarm: 18, filmGrain: 9 },
  fadedBlue: { name: '褪色蓝', brightness: 1, contrast: 6, saturation: -18, vibrance: -6, warmth: -14, tint: 2, highlights: -9, shadows: 14, fade: 15, vignette: 6, sharpen: 2, shadowTeal: 15, highlightWarm: -2, filmGrain: 6 },
  deepSage: { name: '深灰青绿', brightness: -1, contrast: 11, saturation: -22, vibrance: -4, warmth: -5, tint: -8, highlights: -15, shadows: 8, fade: 6, vignette: 10, sharpen: 5, shadowTeal: 12, highlightWarm: 1, filmGrain: 5 },
  nightGold: { name: '夜景黑金', brightness: -5, contrast: 24, saturation: -14, vibrance: 9, warmth: 7, tint: 2, highlights: -8, shadows: -9, fade: 0, vignette: 18, sharpen: 13, shadowTeal: 2, highlightWarm: 21, filmGrain: 2 },
  mono: { name: '黑白纪实', brightness: 1, contrast: 17, saturation: -100, vibrance: 0, warmth: 0, tint: 0, highlights: -14, shadows: 9, fade: 3, vignette: 13, sharpen: 12, shadowTeal: 0, highlightWarm: 0, filmGrain: 8 }
};

$('#colorPresets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-color-preset]');
  const preset = button ? colorPresets[button.dataset.colorPreset] : null;
  if (!preset) return;
  Object.entries(preset).forEach(([id, value]) => {
    if (id !== 'name' && $(`#${id}`)) $(`#${id}`).value = value;
  });
  document.querySelectorAll('[data-color-preset]').forEach((item) => item.classList.toggle('active', item === button));
  $('#presetStatus').textContent = `已应用“${preset.name}”，下面所有参数都可以继续微调`;
  syncControlLabels();
  checkpointHistory();
  scheduleQuickPreview();
  flash(`已应用${preset.name}`);
});

document.querySelectorAll('[data-clarity]').forEach((button) => button.addEventListener('click', () => {
  if (!photos.length) return flash('请先选择图片');
  const enabled = Number($('#clarityAmount').value) <= 0;
  $('#clarityAmount').value = enabled ? 68 : 0;
  document.querySelectorAll('[data-clarity]').forEach((item) => item.classList.toggle('active', enabled));
  syncEffectReceipt(enabled ? '清晰' : '');
  syncControlLabels();
  checkpointHistory();
  scheduleQuickPreview();
  flash(enabled ? '已开启专业清晰：增强真实边缘并保护噪点' : '已关闭一键提高清晰度');
}));

$('#softBeauty').addEventListener('click', () => {
  if (!photos.length) return flash('请先选择人物照片');
  const enabled = Number($('#beautyAmount').value) <= 0;
  $('#beautyAmount').value = enabled ? 58 : 0;
  $('#softBeauty').classList.toggle('active', enabled);
  syncEffectReceipt(enabled ? '清颜' : '');
  syncControlLabels();
  checkpointHistory();
  scheduleQuickPreview();
  flash(enabled ? '正在识别人脸：只优化肤色与面部光线' : '已关闭一键清颜');
});

const photoStandards = {
  cet: {
    name: '四六级常用照', width: 144, height: 192, background: '#c8e3f3', targetKB: 200,
    topRatio: 0.07, sideRatio: 0.06, headRatio: 0.54,
    detail: '已套用144×192像素、浅蓝底、JPG和200KB以内。人物按头顶留白、面部居中、肩部保留的常见构图生成。'
  },
  cet20: {
    name: '四六级小文件版', width: 144, height: 192, background: '#c8e3f3', targetKB: 20,
    topRatio: 0.07, sideRatio: 0.06, headRatio: 0.54,
    detail: '已套用144×192像素、浅蓝底、JPG和20KB以内。仅在本校通知明确要求小于或等于20KB时使用。'
  },
  ntce: {
    name: '教师资格报名照', width: 295, height: 413, background: '#ffffff', targetKB: 200,
    topRatio: 0.08, sideRatio: 0.08, headRatio: 0.64,
    detail: '已套用白底、JPG、200KB以内，并按头部与肩部上方构图。295×413为本站建议输出像素，报名公告未统一限定像素。'
  },
  civil: {
    name: '国考报名照', width: 295, height: 413, background: '#ffffff', targetKB: 0,
    topRatio: 0.08, sideRatio: 0.08, headRatio: 0.64,
    detail: '已套用295×413像素、白底和JPG。国考允许蓝底或白底，提交前仍需使用报名系统指定的照片处理工具。'
  },
  oneInch: {
    name: '标准一寸照', width: 295, height: 413, background: '#ffffff', targetKB: 200,
    topRatio: 0.08, sideRatio: 0.08, headRatio: 0.64,
    detail: '已套用常用一寸电子照规格：295×413像素、白底、JPG和200KB以内。'
  },
  twoInch: {
    name: '标准二寸照', width: 413, height: 579, background: '#ffffff', targetKB: 500,
    topRatio: 0.08, sideRatio: 0.08, headRatio: 0.64,
    detail: '已套用常用二寸电子照规格：413×579像素、白底、JPG和500KB以内。'
  }
};

function syncPhotoStandardUi() {
  document.querySelectorAll('[data-photo-standard]').forEach((button) => {
    button.classList.toggle('active', button.dataset.photoStandard === photoStandardState.id);
  });
  const standard = photoStandards[photoStandardState.id];
  $('#standardResult').innerHTML = standard
    ? `<b>${standard.name}已套用</b><p>${standard.detail}</p>`
    : '<b>选择一种规格</b><p>会自动开启人物识别并套用参数，之后仍可手动调整人物位置和目标KB。</p>';
}

function setSolidPersonBackground(color) {
  backgroundImage = null;
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = '';
  $('#clearBackground').hidden = true;
  const radio = [...document.querySelectorAll('input[name="personBg"]')].find((input) => input.value.toLowerCase() === color.toLowerCase());
  if (radio) {
    radio.checked = true;
    customBackgroundActive = false;
  } else {
    $('#customBgColor').value = color;
    customBackgroundActive = true;
  }
  document.querySelectorAll('[data-quick-bg]').forEach((button) => {
    button.classList.toggle('active', button.dataset.quickBg.toLowerCase() === color.toLowerCase());
  });
}

function applyDeskPreset() {
  if (!deskPreset || deskPresetApplied || !photos.length) return;
  deskPresetApplied = true;
  if (deskPreset.standard && photoStandards[deskPreset.standard]) {
    document.querySelector(`[data-photo-standard="${deskPreset.standard}"]`)?.click();
  }
  if (deskPreset.width || deskPreset.height) {
    $('#resizeEnabled').checked = true;
    if (deskPreset.width) $('#targetWidth').value = deskPreset.width;
    if (deskPreset.height) $('#targetHeight').value = deskPreset.height;
    $('#keepRatio').checked = !(deskPreset.width && deskPreset.height);
  }
  if (deskPreset.maximumKb) $('#targetKB').value = deskPreset.maximumKb;
  if (deskPreset.format) $('#outputFormat').value = deskPreset.format === 'jpg' ? 'jpeg' : deskPreset.format;
  if (deskPreset.background) {
    setSolidPersonBackground(deskPreset.background);
    $('#personEnabled').checked = true;
    $('#portraitPanel').hidden = false;
  }
  if (deskPreset.name) photos.forEach((photo) => { photo.name = deskPreset.name; });
  syncControlLabels();
  renderPhotos();
  refreshResolvedNames();
  checkpointHistory();
  if ($('#personEnabled').checked) renderEditor();
  scheduleQuickPreview();
  $('#jobHandoffDetail').textContent = '参数已自动套用。请核对预览，确认边缘和构图后再导出。';
  flash(`订单 ${deskPreset.job} 的参数已自动套用`);
}

function markDeskReady() {
  if (!deskPreset) return;
  $('#jobHandoffTitle').textContent = `订单 ${deskPreset.job} 成品已生成`;
  $('#jobHandoffDetail').textContent = '保存好文件后，返回接单助手生成交付回复。';
}

function resetColorForOfficialPhoto() {
  ['brightness', 'contrast', 'saturation', 'vibrance', 'warmth', 'tint', 'highlights', 'shadows', 'fade', 'vignette', 'sharpen', 'shadowTeal', 'highlightWarm', 'filmGrain', 'clarityAmount', 'beautyAmount']
    .forEach((id) => { $(`#${id}`).value = 0; });
  $('#softBeauty').classList.remove('active');
  document.querySelectorAll('[data-clarity]').forEach((button) => button.classList.remove('active'));
  syncEffectReceipt();
  document.querySelectorAll('[data-color-preset]').forEach((button) => button.classList.remove('active'));
  $('#presetStatus').textContent = '证件照模式不使用调色或美颜';
}

$('#photoStandardList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-photo-standard]');
  const standard = button ? photoStandards[button.dataset.photoStandard] : null;
  if (!standard) return;
  if (!photos.length) return flash('请先选择一张正面人物照片');
  photoStandardState.id = button.dataset.photoStandard;
  photoStandardState.topRatio = standard.topRatio;
  photoStandardState.sideRatio = standard.sideRatio;
  $('#resizeEnabled').checked = true;
  $('#targetWidth').value = standard.width;
  $('#targetHeight').value = standard.height;
  $('#keepRatio').checked = false;
  $('#cropRatio').value = 'original';
  $('#cropX').value = 50;
  $('#cropY').value = 50;
  transformState.rotation = 0;
  transformState.flipHorizontal = false;
  $('#flipHorizontal').classList.remove('active');
  $('#personEnabled').checked = true;
  $('#portraitPanel').hidden = false;
  $('#outputFormat').value = 'jpeg';
  $('#outputQuality').value = 94;
  $('#targetKB').value = standard.targetKB || '';
  $('#mosaicEnabled').checked = false;
  $('#watermarkText').value = '';
  personState.scale = 1;
  personState.x = 0;
  personState.y = 0;
  $('#personScale').value = 100;
  setSolidPersonBackground(standard.background);
  resetColorForOfficialPhoto();
  syncPhotoStandardUi();
  syncControlLabels();
  refreshResolvedNames();
  checkpointHistory();
  renderEditor();
  scheduleQuickPreview();
  flash(`已套用${standard.name}`);
});

$('#quickBackgrounds').addEventListener('click', (event) => {
  const button = event.target.closest('[data-quick-bg]');
  if (!button) return;
  if (!photos.length) return flash('请先选择人物照片');
  setSolidPersonBackground(button.dataset.quickBg);
  $('#personEnabled').checked = true;
  $('#portraitPanel').hidden = false;
  refreshResolvedNames();
  checkpointHistory();
  renderEditor();
  flash(`已切换为${button.textContent.trim()}`);
});

$('#quickCustomBg').addEventListener('input', () => {
  if (!photos.length) return;
  setSolidPersonBackground($('#quickCustomBg').value);
  $('#personEnabled').checked = true;
  $('#portraitPanel').hidden = false;
  renderEditor();
});

async function loadSegmenter() {
  if (!segmenterPromise) {
    $('#personStatus').textContent = '正在加载本地人物识别模型…';
    segmenterPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe');
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './models/selfie_segmenter.tflite' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: true
      });
    })();
  }
  return segmenterPromise;
}

function canvas2d(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function foregroundRegion(confidence, width, height, threshold) {
  const labels = new Int32Array(confidence.length);
  const queue = new Int32Array(confidence.length);
  let label = 0;
  let bestLabel = 0;
  let bestSize = 0;
  for (let start = 0; start < confidence.length; start += 1) {
    if (labels[start] || confidence[start] < threshold) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        const nearbyY = y + dy;
        if (nearbyY < 0 || nearbyY >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nearbyX = x + dx;
          if (nearbyX < 0 || nearbyX >= width) continue;
          const nearby = nearbyY * width + nearbyX;
          if (!labels[nearby] && confidence[nearby] >= threshold) {
            labels[nearby] = label;
            queue[tail++] = nearby;
          }
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = label;
    }
  }
  if (!bestLabel) return new Uint8Array(confidence.length).fill(1);
  const allowed = new Uint8Array(confidence.length);
  for (let pixel = 0; pixel < labels.length; pixel += 1) {
    if (labels[pixel] !== bestLabel) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let dy = -2; dy <= 2; dy += 1) {
      const nearbyY = y + dy;
      if (nearbyY < 0 || nearbyY >= height) continue;
      for (let dx = -2; dx <= 2; dx += 1) {
        const nearbyX = x + dx;
        if (nearbyX >= 0 && nearbyX < width) allowed[nearbyY * width + nearbyX] = 1;
      }
    }
  }
  return allowed;
}

function tightenMask(imageData, width, height, edge, sourceData) {
  const alpha = new Uint8ClampedArray(width * height);
  const guidedAlpha = new Uint8ClampedArray(width * height);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = imageData.data[pixel * 4 + 3];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const centerAlpha = alpha[pixel];
      if (centerAlpha <= 1 || centerAlpha >= 254 || !sourceData) {
        guidedAlpha[pixel] = centerAlpha;
        continue;
      }
      const centerOffset = pixel * 4;
      let total = 0;
      let weightTotal = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nearbyPixel = (y + dy) * width + x + dx;
          const nearbyOffset = nearbyPixel * 4;
          const red = sourceData[nearbyOffset] - sourceData[centerOffset];
          const green = sourceData[nearbyOffset + 1] - sourceData[centerOffset + 1];
          const blue = sourceData[nearbyOffset + 2] - sourceData[centerOffset + 2];
          const colorDistance = red * red + green * green + blue * blue;
          const spatialWeight = dx === 0 && dy === 0 ? 1 : dx === 0 || dy === 0 ? 0.72 : 0.50;
          const weight = spatialWeight / (1 + colorDistance / 720);
          total += alpha[nearbyPixel] * weight;
          weightTotal += weight;
        }
      }
      guidedAlpha[pixel] = total / Math.max(0.0001, weightTotal);
    }
  }
  for (let x = 0; x < width; x += 1) {
    guidedAlpha[x] = alpha[x];
    guidedAlpha[(height - 1) * width + x] = alpha[(height - 1) * width + x];
  }
  for (let y = 0; y < height; y += 1) {
    guidedAlpha[y * width] = alpha[y * width];
    guidedAlpha[y * width + width - 1] = alpha[y * width + width - 1];
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      let minimum = guidedAlpha[pixel];
      let maximum = guidedAlpha[pixel];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const value = guidedAlpha[(y + dy) * width + x + dx];
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
      const boundary = smoothStep(7, 72, maximum - minimum);
      const shrink = boundary * (0.10 + edge / 100 * 0.22);
      const aligned = guidedAlpha[pixel] * (1 - shrink) + minimum * shrink;
      const cutoff = 4 + edge * 0.14;
      const normalized = clamp((aligned - cutoff) / Math.max(1, 255 - cutoff), 0, 1);
      const refined = Math.pow(normalized, 1 + edge / 480) * 255;
      imageData.data[pixel * 4 + 3] = refined < 2 ? 0 : refined > 249 ? 255 : refined;
    }
  }
}

function estimateBorderBackground(sourceData, maskData, width, height) {
  const reds = [];
  const greens = [];
  const blues = [];
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 240));
  const bandX = Math.max(4, Math.round(width * 0.06));
  const bandY = Math.max(4, Math.round(height * 0.06));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (x >= bandX && x < width - bandX && y >= bandY && y < height - bandY) continue;
      const offset = (y * width + x) * 4;
      if (maskData[offset + 3] > 96) continue;
      reds.push(sourceData[offset]);
      greens.push(sourceData[offset + 1]);
      blues.push(sourceData[offset + 2]);
    }
  }
  if (reds.length < 32) return null;
  const color = [medianNumber(reds), medianNumber(greens), medianNumber(blues)];
  const distances = reds.map((red, index) => Math.hypot(
    red - color[0],
    greens[index] - color[1],
    blues[index] - color[2]
  ));
  const spread = medianNumber(distances, 255);
  if (spread > 52) return null;
  return {
    color,
    spread,
    tolerance: clamp(20 + spread * 2.4, 24, 64)
  };
}

function suppressUniformBackgroundSpill(maskData, sourceData, width, height, edge, background) {
  if (!background) return null;
  const pixelCount = width * height;
  let band = new Uint8Array(pixelCount);
  let expanded = new Uint8Array(pixelCount);
  const edgeDepth = new Uint8Array(pixelCount);
  edgeDepth.fill(255);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (maskData[pixel * 4 + 3] < 248) {
      band[pixel] = 1;
      edgeDepth[pixel] = 0;
    }
  }
  const radius = clamp(Math.round(Math.min(width, height) * 0.005), 4, 9);
  for (let pass = 0; pass < radius; pass += 1) {
    expanded.set(band);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const pixel = y * width + x;
        if (band[pixel]) continue;
        if (
          band[pixel - width - 1] || band[pixel - width] || band[pixel - width + 1]
          || band[pixel - 1] || band[pixel + 1]
          || band[pixel + width - 1] || band[pixel + width] || band[pixel + width + 1]
        ) {
          expanded[pixel] = 1;
          edgeDepth[pixel] = Math.min(edgeDepth[pixel], pass + 1);
        }
      }
    }
    [band, expanded] = [expanded, band];
  }

  const spillStrength = new Uint8Array(pixelCount);
  const [backgroundRed, backgroundGreen, backgroundBlue] = background.color;
  const near = background.tolerance * 0.72;
  const far = background.tolerance * 4.8;
  const removalScale = 0.86 + edge / 900;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (!band[pixel]) continue;
    const offset = pixel * 4;
    const alpha = maskData[offset + 3];
    if (alpha <= 2) continue;
    const distance = Math.hypot(
      sourceData[offset] - backgroundRed,
      sourceData[offset + 1] - backgroundGreen,
      sourceData[offset + 2] - backgroundBlue
    );
    const similarity = 1 - smoothStep(near, far, distance);
    if (similarity <= 0.015) continue;
    const removal = clamp(similarity * removalScale, 0, 0.98);
    const refinedAlpha = distance <= near
      ? 0
      : alpha * (1 - removal);
    if (refinedAlpha >= alpha - 1) continue;
    maskData[offset + 3] = refinedAlpha < 2 ? 0 : refinedAlpha;
    spillStrength[pixel] = Math.round(removal * 255);
  }
  return { strength: spillStrength, edgeDepth, radius };
}

function decontaminateEdgeBand(imageData, width, height, background, edge) {
  if (!background) return;
  const data = imageData.data;
  const pixelCount = width * height;
  const nearestInterior = new Int32Array(pixelCount);
  const depth = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  nearestInterior.fill(-1);
  depth.fill(255);
  let queueStart = 0;
  let queueEnd = 0;
  const alphaAt = (pixel) => data[pixel * 4 + 3];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      if (alphaAt(pixel) < 244) continue;
      const touchesSoftEdge = (
        alphaAt(pixel - width) < 244
        || alphaAt(pixel - 1) < 244
        || alphaAt(pixel + 1) < 244
        || alphaAt(pixel + width) < 244
      );
      if (!touchesSoftEdge) continue;
      nearestInterior[pixel] = pixel;
      depth[pixel] = 0;
      queue[queueEnd] = pixel;
      queueEnd += 1;
    }
  }

  const radius = clamp(Math.round(5 + edge / 20), 5, 10);
  const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  while (queueStart < queueEnd) {
    const pixel = queue[queueStart];
    queueStart += 1;
    const nextDepth = depth[pixel] + 1;
    if (nextDepth > radius) continue;
    const x = pixel % width;
    if (x <= 1 || x >= width - 2 || pixel < width * 2 || pixel >= pixelCount - width * 2) continue;
    for (const delta of neighbors) {
      const nearby = pixel + delta;
      if (nearestInterior[nearby] >= 0) continue;
      const alpha = alphaAt(nearby);
      if (alpha <= 1 || alpha >= 249) continue;
      nearestInterior[nearby] = nearestInterior[pixel];
      depth[nearby] = nextDepth;
      queue[queueEnd] = nearby;
      queueEnd += 1;
    }
  }

  const backgroundColor = background.color;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const seed = nearestInterior[pixel];
    if (seed < 0 || depth[pixel] === 0) continue;
    const offset = pixel * 4;
    const seedOffset = seed * 4;
    const alpha = data[offset + 3];
    const opacity = alpha / 255;
    if (opacity <= 0.005 || opacity >= 0.985) continue;
    const backgroundDistance = Math.hypot(
      data[offset] - backgroundColor[0],
      data[offset + 1] - backgroundColor[1],
      data[offset + 2] - backgroundColor[2]
    );
    const backgroundAffinity = 1 - smoothStep(
      background.tolerance * 0.65,
      background.tolerance * 3.5,
      backgroundDistance
    );
    const outerWeight = smoothStep(0.02, 0.90, 1 - opacity);
    const depthWeight = 1 - smoothStep(radius * 0.55, radius + 0.5, depth[pixel]);
    const correction = clamp(
      outerWeight * (0.50 + edge / 240) + backgroundAffinity * depthWeight * 0.48,
      0,
      0.94
    );
    for (let channel = 0; channel < 3; channel += 1) {
      const observed = data[offset + channel];
      const seedColor = data[seedOffset + channel];
      const recovered = clamp(
        (observed - (1 - opacity) * backgroundColor[channel]) / Math.max(0.16, opacity),
        seedColor - 76,
        seedColor + 76
      );
      const cleanColor = recovered * 0.76 + seedColor * 0.24;
      data[offset + channel] = observed * (1 - correction) + cleanColor * correction;
    }
    const alphaReduction = backgroundAffinity * depthWeight * (0.08 + edge / 360);
    const refinedAlpha = alpha * (1 - alphaReduction);
    data[offset + 3] = refinedAlpha < 2 ? 0 : refinedAlpha;
  }
}

function activeTextPhoto() {
  return photos.find((photo) => photo.id === activeTextPhotoId) || null;
}

function replacementFont(value) {
  if (value === 'serif') return '"STSong", "Songti SC", "SimSun", serif';
  if (value === 'kai') return '"Kaiti SC", "STKaiti", "KaiTi", serif';
  if (value === 'fang') return '"STFangsong", "FangSong", "FangSong_GB2312", serif';
  if (value === 'mono') return 'Consolas, "Microsoft YaHei", monospace';
  return '"PingFang SC", "Microsoft YaHei", sans-serif';
}

function smartCoverTextBackground(context, x, y, width, height, fallbackColor) {
  const canvas = context.canvas;
  const padding = Math.max(4, Math.min(36, Math.round(Math.min(width, height) * 0.24)));
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(canvas.width, Math.ceil(x + width));
  const bottom = Math.min(canvas.height, Math.ceil(y + height));
  const targetWidth = right - left;
  const targetHeight = bottom - top;
  if (targetWidth < 1 || targetHeight < 1) return;
  const sourceLeft = Math.max(0, left - padding);
  const sourceTop = Math.max(0, top - padding);
  const sourceRight = Math.min(canvas.width, right + padding);
  const sourceBottom = Math.min(canvas.height, bottom + padding);
  try {
    const source = context.getImageData(sourceLeft, sourceTop, sourceRight - sourceLeft, sourceBottom - sourceTop);
    const output = context.createImageData(targetWidth, targetHeight);
    const sampleChannel = (globalX, globalY, channel) => {
      const localX = Math.max(0, Math.min(source.width - 1, globalX - sourceLeft));
      const localY = Math.max(0, Math.min(source.height - 1, globalY - sourceTop));
      const offset = (localY * source.width + localX) * 4;
      return source.data[offset + channel];
    };
    const sampleDepth = Math.max(2, Math.min(8, padding));
    const bandAverage = (edge, globalX, globalY, channel) => {
      let total = 0;
      for (let depth = 0; depth < sampleDepth; depth += 1) {
        if (edge === 'top') total += sampleChannel(globalX, top - 1 - depth, channel);
        if (edge === 'bottom') total += sampleChannel(globalX, bottom + depth, channel);
        if (edge === 'left') total += sampleChannel(left - 1 - depth, globalY, channel);
        if (edge === 'right') total += sampleChannel(right + depth, globalY, channel);
      }
      return total / sampleDepth;
    };
    const depthSample = (edge, globalX, globalY, depth, channel) => {
      const first = Math.max(0, Math.min(sampleDepth - 1, Math.floor(depth)));
      const second = Math.min(sampleDepth - 1, first + 1);
      const mix = Math.max(0, Math.min(1, depth - first));
      const at = (current) => {
        if (edge === 'top') return sampleChannel(globalX, top - 1 - current, channel);
        if (edge === 'bottom') return sampleChannel(globalX, bottom + current, channel);
        if (edge === 'left') return sampleChannel(left - 1 - current, globalY, channel);
        return sampleChannel(right + current, globalY, channel);
      };
      return at(first) * (1 - mix) + at(second) * mix;
    };
    const topColors = new Float32Array(targetWidth * 3);
    const bottomColors = new Float32Array(targetWidth * 3);
    const leftColors = new Float32Array(targetHeight * 3);
    const rightColors = new Float32Array(targetHeight * 3);
    for (let px = 0; px < targetWidth; px += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        topColors[px * 3 + channel] = bandAverage('top', left + px, top, channel);
        bottomColors[px * 3 + channel] = bandAverage('bottom', left + px, bottom, channel);
      }
    }
    for (let py = 0; py < targetHeight; py += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        leftColors[py * 3 + channel] = bandAverage('left', left, top + py, channel);
        rightColors[py * 3 + channel] = bandAverage('right', right, top + py, channel);
      }
    }
    for (let py = 0; py < targetHeight; py += 1) {
      const globalY = top + py;
      for (let px = 0; px < targetWidth; px += 1) {
        const globalX = left + px;
        const u = (px + 0.5) / targetWidth;
        const v = (py + 0.5) / targetHeight;
        const weights = [
          1 / Math.pow(u + 0.07, 1.65),
          1 / Math.pow(1 - u + 0.07, 1.65),
          1 / Math.pow(v + 0.07, 1.65),
          1 / Math.pow(1 - v + 0.07, 1.65)
        ];
        const weightTotal = weights.reduce((sum, value) => sum + value, 0);
        const outputOffset = (py * targetWidth + px) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const edgeColors = [
            leftColors[py * 3 + channel],
            rightColors[py * 3 + channel],
            topColors[px * 3 + channel],
            bottomColors[px * 3 + channel]
          ];
          const base = edgeColors.reduce((sum, value, index) => sum + value * weights[index], 0) / weightTotal;
          const topTexture = depthSample('top', globalX, globalY, v * (sampleDepth - 1), channel) - edgeColors[2];
          const bottomTexture = depthSample('bottom', globalX, globalY, (1 - v) * (sampleDepth - 1), channel) - edgeColors[3];
          const leftTexture = depthSample('left', globalX, globalY, u * (sampleDepth - 1), channel) - edgeColors[0];
          const rightTexture = depthSample('right', globalX, globalY, (1 - u) * (sampleDepth - 1), channel) - edgeColors[1];
          const texture = (
            leftTexture * weights[0] + rightTexture * weights[1]
            + topTexture * weights[2] + bottomTexture * weights[3]
          ) / weightTotal;
          output.data[outputOffset + channel] = Math.max(0, Math.min(255, Math.round(base + texture * 0.08)));
        }
        output.data[outputOffset + 3] = 255;
      }
    }
    context.putImageData(output, left, top);
  } catch (error) {
    console.warn('Smart background repair failed, using sampled color.', error);
    context.fillStyle = fallbackColor;
    context.fillRect(left, top, targetWidth, targetHeight);
  }
}

function drawTrackedText(context, text, x, y, maxWidth, desiredWidth) {
  const characters = Array.from(text);
  if (characters.length < 2) {
    context.fillText(text, x, y, maxWidth);
    return;
  }
  const widths = characters.map((character) => context.measureText(character).width);
  const rawWidth = widths.reduce((sum, value) => sum + value, 0);
  const targetWidth = Math.max(rawWidth * 0.82, Math.min(maxWidth, desiredWidth || rawWidth));
  const tracking = Math.max(-rawWidth * 0.035, (targetWidth - rawWidth) / (characters.length - 1));
  let cursor = x;
  characters.forEach((character, index) => {
    context.fillText(character, cursor, y);
    cursor += widths[index] + (index < characters.length - 1 ? tracking : 0);
  });
}

function drawTextEdit(canvas, edit) {
  const context = canvas.getContext('2d');
  const x = edit.x * canvas.width;
  const y = edit.y * canvas.height;
  const width = edit.width * canvas.width;
  const height = edit.height * canvas.height;
  const coverPadding = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) * 0.002));
  context.save();
  if (edit.backgroundMode === 'smart') {
    smartCoverTextBackground(
      context,
      x - coverPadding,
      y - coverPadding,
      width + coverPadding * 2,
      height + coverPadding * 2,
      edit.backgroundColor
    );
  } else {
    context.fillStyle = edit.backgroundColor;
    context.fillRect(x - coverPadding, y - coverPadding, width + coverPadding * 2, height + coverPadding * 2);
  }
  const lines = String(edit.text || '').split(/\r?\n/).slice(0, 5);
  if (!lines.some(Boolean)) { context.restore(); return; }
  const layout = edit.layout || null;
  const leftRatio = layout ? Math.max(0, Math.min(0.3, layout.leftRatio ?? 0.04)) : 0.04;
  const rightRatio = layout ? Math.max(0, Math.min(0.3, layout.rightInsetRatio ?? 0.04)) : 0.04;
  const innerWidth = width * (1 - leftRatio - rightRatio);
  const lineHeight = height / Math.max(1, lines.length);
  const sizeScale = edit.size / Math.max(1, edit.baseSize || 100);
  let fontSize = layout && lines.length === 1
    ? Math.max(6, height * Math.max(0.2, layout.glyphHeightRatio || 0.68) / 0.86 * sizeScale)
    : Math.max(6, lineHeight * 0.68 * edit.size / 100);
  context.font = `${edit.bold ? 700 : 400} ${fontSize}px ${replacementFont(edit.font)}`;
  if (layout && lines.length === 1) {
    const probe = context.measureText(edit.sourceText || lines[0]);
    const measuredHeight = (probe.actualBoundingBoxAscent || fontSize * 0.78)
      + (probe.actualBoundingBoxDescent || fontSize * 0.08);
    const targetHeight = height * (layout.glyphHeightRatio || 0.68) * sizeScale;
    if (measuredHeight > 0) fontSize *= targetHeight / measuredHeight;
    context.font = `${edit.bold ? 700 : 400} ${fontSize}px ${replacementFont(edit.font)}`;
  }
  const widest = Math.max(...lines.map((line) => context.measureText(line).width), 1);
  if (widest > innerWidth) fontSize *= innerWidth / widest;
  context.font = `${edit.bold ? 700 : 400} ${fontSize}px ${replacementFont(edit.font)}`;
  context.fillStyle = edit.color;
  context.globalAlpha = Math.max(0.25, Math.min(1, edit.opacity ?? 1));
  const softnessPixels = Math.max(0, Math.min(height * 0.04, (edit.softnessRatio || 0) * height));
  context.filter = softnessPixels > 0.04 ? `blur(${softnessPixels.toFixed(2)}px)` : 'none';
  context.fontKerning = 'normal';
  context.textBaseline = layout && lines.length === 1 ? 'alphabetic' : 'middle';
  context.textAlign = 'left';
  const left = x + width * leftRatio;
  lines.forEach((line, index) => {
    const metrics = context.measureText(line);
    const centerY = layout && lines.length === 1
      ? y + height * Math.max(0.01, Math.min(0.92, layout.topRatio ?? 0.16))
        + (metrics.actualBoundingBoxAscent || fontSize * 0.78)
      : y + (index + 0.5) * lineHeight;
    const desiredWidth = layout?.advanceRatio
      ? Math.min(innerWidth, layout.advanceRatio * width * Array.from(line.replace(/\s/g, '')).length)
      : undefined;
    drawTrackedText(context, line, left, centerY, innerWidth, desiredWidth);
  });
  context.restore();
}

function drawEditDisclosure(canvas) {
  const context = canvas.getContext('2d');
  const fontSize = Math.max(11, Math.min(30, Math.round(Math.min(canvas.width, canvas.height) * 0.027)));
  const label = '已编辑 · 校正版';
  context.save();
  context.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  const paddingX = Math.round(fontSize * 0.72);
  const paddingY = Math.round(fontSize * 0.48);
  const width = Math.ceil(context.measureText(label).width + paddingX * 2);
  const height = Math.ceil(fontSize + paddingY * 2);
  const x = Math.max(0, canvas.width - width - Math.round(fontSize * 0.65));
  const y = Math.max(0, canvas.height - height - Math.round(fontSize * 0.65));
  context.globalAlpha = 0.86;
  context.fillStyle = '#8e432f';
  context.fillRect(x, y, width, height);
  context.globalAlpha = 1;
  context.fillStyle = '#fffaf1';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(label, x + paddingX, y + height / 2);
  context.restore();
}

function applyTextEdits(canvas, photo) {
  (photo.textEdits || []).forEach((edit) => drawTextEdit(canvas, edit));
  if (photo.textEdits?.length) drawEditDisclosure(canvas);
  return canvas;
}

function activeRemovePhoto() {
  return photos.find((photo) => photo.id === activeRemovePhotoId) || null;
}

function applyRemovalEdits(canvas, photo) {
  const context = canvas.getContext('2d');
  (photo.removals || []).forEach((removal) => {
    smartCoverTextBackground(
      context,
      removal.x * canvas.width,
      removal.y * canvas.height,
      removal.width * canvas.width,
      removal.height * canvas.height,
      removal.backgroundColor || '#ffffff'
    );
  });
  return canvas;
}

function syncRemoveActions() {
  const selected = Boolean(removeSelection && removeSelection.width >= 5 && removeSelection.height >= 5);
  $('#applySmartRemove').disabled = !selected;
  $('#clearRemoveSelection').disabled = !selected;
  $('#undoSmartRemove').disabled = !activeRemovePhoto()?.removals?.length;
}

function renderRemoveEditorCanvas() {
  const photo = activeRemovePhoto();
  if (!photo || !removeEditorOriginal) return;
  removeEditCanvas.width = removeEditorOriginal.width;
  removeEditCanvas.height = removeEditorOriginal.height;
  const context = removeEditCanvas.getContext('2d');
  context.drawImage(removeEditorOriginal, 0, 0);
  applyRemovalEdits(removeEditCanvas, photo);
  if (removeSelection) {
    context.save();
    context.strokeStyle = '#ad573b';
    context.lineWidth = Math.max(2, removeEditCanvas.width / 420);
    context.setLineDash([8, 5]);
    context.fillStyle = 'rgba(173,87,59,.12)';
    context.fillRect(removeSelection.x, removeSelection.y, removeSelection.width, removeSelection.height);
    context.strokeRect(removeSelection.x, removeSelection.y, removeSelection.width, removeSelection.height);
    context.restore();
  }
  syncRemoveActions();
}

async function openRemoveEditor(photo = photos[0]) {
  if (!photo) return flash('请先选择一张图片');
  activeRemovePhotoId = photo.id;
  const image = await photo.imagePromise;
  const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
  removeEditorOriginal = canvas2d(
    Math.max(1, Math.round(image.naturalWidth * scale)),
    Math.max(1, Math.round(image.naturalHeight * scale))
  );
  removeEditorOriginal.getContext('2d').drawImage(image, 0, 0, removeEditorOriginal.width, removeEditorOriginal.height);
  removeSelection = null;
  removeSelectionStart = null;
  $('#removePhotoName').textContent = `正在编辑：${photo.name}`;
  $('#removeStatus').textContent = '请先在图片上框选区域';
  $('#removeEditorPanel').hidden = false;
  document.body.classList.add('text-editor-open');
  renderRemoveEditorCanvas();
}

function closeRemoveEditor() {
  activeRemovePhotoId = null;
  removeEditorOriginal = null;
  removeSelection = null;
  removeSelectionStart = null;
  $('#removeEditorPanel').hidden = true;
  if ($('#textEditPanel').hidden) document.body.classList.remove('text-editor-open');
}

function pointerOnRemoveCanvas(event) {
  const rect = removeEditCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(removeEditCanvas.width, (event.clientX - rect.left) * removeEditCanvas.width / rect.width)),
    y: Math.max(0, Math.min(removeEditCanvas.height, (event.clientY - rect.top) * removeEditCanvas.height / rect.height))
  };
}

function renderTextEditorCanvas() {
  const photo = activeTextPhoto();
  if (!photo || !textEditorOriginal) return;
  textEditCanvas.width = textEditorOriginal.width;
  textEditCanvas.height = textEditorOriginal.height;
  const context = textEditCanvas.getContext('2d');
  context.drawImage(textEditorOriginal, 0, 0);
  applyRemovalEdits(textEditCanvas, photo);
  applyTextEdits(textEditCanvas, photo);
  if (textSelection) {
    context.save();
    context.strokeStyle = '#ad573b';
    context.lineWidth = Math.max(2, textEditCanvas.width / 420);
    context.setLineDash([8, 5]);
    context.fillStyle = 'rgba(173,87,59,.10)';
    context.fillRect(textSelection.x, textSelection.y, textSelection.width, textSelection.height);
    context.strokeRect(textSelection.x, textSelection.y, textSelection.width, textSelection.height);
    context.restore();
  }
  syncTextEditorActions();
}

function syncTextEditorActions() {
  const selected = Boolean(textSelection && textSelection.width >= 5 && textSelection.height >= 5);
  const photo = activeTextPhoto();
  $('#recognizeSelection').disabled = !selected;
  $('#clearTextSelection').disabled = !selected;
  $('#applyTextReplacement').disabled = !selected || !$('#replacementText').value.trim();
  $('#undoTextReplacement').disabled = !photo?.textEdits?.length;
}

async function openTextEditor(photo = photos[0]) {
  if (!photo) return flash('请先选择一张图片');
  activeTextPhotoId = photo.id;
  const image = await photo.imagePromise;
  const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  textEditorOriginal = canvas2d(
    Math.max(1, Math.round(image.naturalWidth * scale)),
    Math.max(1, Math.round(image.naturalHeight * scale))
  );
  textEditorOriginal.getContext('2d').drawImage(image, 0, 0, textEditorOriginal.width, textEditorOriginal.height);
  textSelection = null;
  matchedTextStyle = null;
  recognizedSourceText = '';
  $('#replacementText').value = '';
  $('#replacementFont').value = 'auto';
  $('#replacementOpacity').value = 100;
  $('#replacementSoftness').value = 0;
  syncInkControlLabels();
  $('#styleMatchStatus').textContent = '识别原文字后会自动匹配最接近的样式';
  $('#textEditPhotoName').textContent = `正在编辑：${photo.name}`;
  $('#ocrStatus').textContent = '请先在图片上框选文字';
  $('#textEditPanel').hidden = false;
  document.body.classList.add('text-editor-open');
  renderTextEditorCanvas();
  loadOcrWorker().then(() => {
    $('#ocrStatus').textContent = textSelection
      ? '选区完成：直接输入新文字，或让它先自动识别'
      : '识别已准备好，请框选文字';
  }).catch((error) => {
    console.error(error);
    $('#ocrStatus').textContent = '自动识别暂不可用，仍可框选后直接输入新文字';
  });
}

function closeTextEditor() {
  activeTextPhotoId = null;
  textEditorOriginal = null;
  textSelection = null;
  textSelectionStart = null;
  matchedTextStyle = null;
  recognizedSourceText = '';
  $('#textEditPanel').hidden = true;
  document.body.classList.remove('text-editor-open');
}

function pointerOnTextCanvas(event) {
  const rect = textEditCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(textEditCanvas.width, (event.clientX - rect.left) * textEditCanvas.width / rect.width)),
    y: Math.max(0, Math.min(textEditCanvas.height, (event.clientY - rect.top) * textEditCanvas.height / rect.height))
  };
}

function sampledBackground(canvas, selection) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const band = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.006));
  const left = Math.max(0, Math.floor(selection.x - band));
  const top = Math.max(0, Math.floor(selection.y - band));
  const right = Math.min(canvas.width, Math.ceil(selection.x + selection.width + band));
  const bottom = Math.min(canvas.height, Math.ceil(selection.y + selection.height + band));
  const pixels = context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  const reds = [];
  const greens = [];
  const blues = [];
  const step = Math.max(1, Math.floor((pixels.width + pixels.height) / 450));
  for (let y = 0; y < pixels.height; y += step) {
    for (let x = 0; x < pixels.width; x += step) {
      const globalX = left + x;
      const globalY = top + y;
      const outside = globalX < selection.x || globalX > selection.x + selection.width
        || globalY < selection.y || globalY > selection.y + selection.height;
      if (!outside) continue;
      const offset = (y * pixels.width + x) * 4;
      reds.push(pixels.data[offset]);
      greens.push(pixels.data[offset + 1]);
      blues.push(pixels.data[offset + 2]);
    }
  }
  const median = (values) => values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : 255;
  const red = median(reds);
  const green = median(greens);
  const blue = median(blues);
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function rgbFromHex(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}

function medianNumber(values, fallback = 0) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function analyzeSelectionStyle(canvas, selection) {
  const background = sampledBackground(canvas, selection);
  const backgroundRgb = rgbFromHex(background);
  const left = Math.max(0, Math.floor(selection.x));
  const top = Math.max(0, Math.floor(selection.y));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(selection.width)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(selection.height)));
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(left, top, width, height);
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / 100000)));
  const samples = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const rgb = [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2]];
      const distance = Math.hypot(
        rgb[0] - backgroundRgb[0],
        rgb[1] - backgroundRgb[1],
        rgb[2] - backgroundRgb[2]
      );
      samples.push({ rgb, distance, x, y });
    }
  }
  const distances = samples.map((sample) => sample.distance).sort((a, b) => a - b);
  const threshold = Math.max(34, distances[Math.floor(distances.length * 0.70)] || 34);
  const strongThreshold = Math.max(threshold, distances[Math.floor(distances.length * 0.84)] || threshold);
  const ink = samples.filter((sample) => sample.distance >= threshold);
  const strongInk = samples.filter((sample) => sample.distance >= strongThreshold);
  const colorSamples = strongInk.length >= 6 ? strongInk : ink;
  let color = rgbToHex([0, 1, 2].map((channel) => medianNumber(
    colorSamples.map((sample) => sample.rgb[channel]),
    backgroundRgb[channel] > 128 ? 24 : 238
  )));
  if (Math.hypot(...rgbFromHex(color).map((value, index) => value - backgroundRgb[index])) < 42) {
    const lightness = backgroundRgb[0] * 0.299 + backgroundRgb[1] * 0.587 + backgroundRgb[2] * 0.114;
    color = lightness > 140 ? '#202020' : '#ffffff';
  }
  const observedColor = color;
  const observedInk = rgbFromHex(observedColor);
  const inkDirection = observedInk.map((value, index) => value - backgroundRgb[index]);
  const extensionLimits = inkDirection.map((direction, index) => {
    if (direction > 0.5) return (255 - backgroundRgb[index]) / direction;
    if (direction < -0.5) return (0 - backgroundRgb[index]) / direction;
    return Number.POSITIVE_INFINITY;
  }).filter((value) => Number.isFinite(value) && value > 0);
  const inkExtension = Math.max(1, Math.min(4, extensionLimits.length ? Math.min(...extensionLimits) : 1));
  const pureInk = backgroundRgb.map((value, index) => value + inkDirection[index] * inkExtension);
  const opacity = Math.max(0.25, Math.min(1, 1 / inkExtension));
  color = rgbToHex(pureInk);
  const inkDistances = ink.map((sample) => sample.distance).sort((a, b) => a - b);
  const medianInkDistance = inkDistances[Math.floor(inkDistances.length * 0.50)] || threshold;
  const deepInkDistance = inkDistances[Math.floor(inkDistances.length * 0.90)] || medianInkDistance;
  const softness = Math.max(0, Math.min(1.6, (1 - medianInkDistance / Math.max(1, deepInkDistance)) * 2.1));
  const glyphBounds = ink.reduce((bounds, sample) => ({
    minX: Math.min(bounds.minX, sample.x),
    maxX: Math.max(bounds.maxX, sample.x),
    minY: Math.min(bounds.minY, sample.y),
    maxY: Math.max(bounds.maxY, sample.y)
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  });
  const glyphHeight = ink.length ? glyphBounds.maxY - glyphBounds.minY + step : height * 0.68;
  const glyphWidth = ink.length ? glyphBounds.maxX - glyphBounds.minX + step : width * 0.92;
  const layout = {
    leftRatio: ink.length ? Math.max(0.01, glyphBounds.minX / width) : 0.04,
    rightInsetRatio: ink.length ? Math.max(0.01, 1 - (glyphBounds.maxX + step) / width) : 0.04,
    topRatio: ink.length ? Math.max(0.01, glyphBounds.minY / height) : 0.16,
    bottomRatio: ink.length ? Math.min(0.99, (glyphBounds.maxY + step) / height) : 0.84,
    centerYRatio: ink.length ? (glyphBounds.minY + glyphBounds.maxY + step) / 2 / height : 0.5,
    glyphHeightRatio: Math.max(0.16, Math.min(0.94, glyphHeight / height)),
    glyphWidthRatio: Math.max(0.1, Math.min(1, glyphWidth / width))
  };
  const coverage = ink.length / Math.max(1, samples.length);
  return {
    background,
    backgroundRgb,
    observedColor,
    color,
    opacity,
    softness,
    bold: coverage > 0.22,
    size: Math.max(55, Math.min(150, Math.round((glyphHeight / height) / 0.68 * 100))),
    threshold,
    layout
  };
}

function normalizedAlphaMask(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width;
  let top = canvas.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = pixels.data[(y * canvas.width + x) * 4 + 3];
      if (alpha < 28) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  const normalized = canvas2d(96, 56);
  const normalizedContext = normalized.getContext('2d', { willReadFrequently: true });
  normalizedContext.imageSmoothingEnabled = true;
  normalizedContext.imageSmoothingQuality = 'high';
  normalizedContext.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, 0, 0, 96, 56);
  const normalizedPixels = normalizedContext.getImageData(0, 0, 96, 56).data;
  const alpha = new Uint8Array(96 * 56);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = normalizedPixels[index * 4 + 3];
  return alpha;
}

function selectionTextMask(canvas, selection, style) {
  const left = Math.max(0, Math.floor(selection.x));
  const top = Math.max(0, Math.floor(selection.y));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(selection.width)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(selection.height)));
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(left, top, width, height);
  const mask = canvas2d(width, height);
  const maskContext = mask.getContext('2d');
  const maskPixels = maskContext.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const distance = Math.hypot(
      pixels.data[offset] - style.backgroundRgb[0],
      pixels.data[offset + 1] - style.backgroundRgb[1],
      pixels.data[offset + 2] - style.backgroundRgb[2]
    );
    const alpha = Math.max(0, Math.min(255, (distance - style.threshold * 0.48) * 255 / Math.max(18, style.threshold * 0.72)));
    maskPixels.data[offset] = 0;
    maskPixels.data[offset + 1] = 0;
    maskPixels.data[offset + 2] = 0;
    maskPixels.data[offset + 3] = alpha;
  }
  maskContext.putImageData(maskPixels, 0, 0);
  return normalizedAlphaMask(mask);
}

function renderedTextMask(text, font, bold) {
  const sample = canvas2d(1200, 300);
  const context = sample.getContext('2d');
  const content = String(text).replace(/\s+/g, ' ').trim().slice(0, 32);
  let size = 200;
  context.font = `${bold ? 700 : 400} ${size}px ${replacementFont(font)}`;
  const measured = Math.max(1, context.measureText(content).width);
  if (measured > 1150) size *= 1150 / measured;
  context.font = `${bold ? 700 : 400} ${size}px ${replacementFont(font)}`;
  context.fontKerning = 'normal';
  context.fillStyle = '#000';
  context.textBaseline = 'middle';
  context.fillText(content, 20, 150);
  return normalizedAlphaMask(sample);
}

function maskDifference(first, second) {
  if (!first || !second || first.length !== second.length) return Number.POSITIVE_INFINITY;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference += Math.abs(first[index] - second[index]);
  return difference / (first.length * 255);
}

async function detectClosestFont(canvas, selection, sourceText, style) {
  const candidates = ['sans', 'serif', 'kai', 'fang', 'mono'];
  const sourceMask = selectionTextMask(canvas, selection, style);
  if (!sourceMask) return { font: 'sans', bold: style.bold };
  let best = { font: 'sans', bold: style.bold, score: Number.POSITIVE_INFINITY };
  const fontPrior = { serif: 0, sans: 0.002, fang: 0.014, kai: 0.018, mono: 0.022 };
  for (const font of candidates) {
    for (const bold of [style.bold, !style.bold]) {
      const score = maskDifference(sourceMask, renderedTextMask(sourceText, font, bold))
        + (bold === style.bold ? 0 : 0.012)
        + fontPrior[font];
      if (score < best.score) best = { font, bold, score };
    }
  }
  return best;
}

function applyBasicMatchedStyle(style) {
  matchedTextStyle = style;
  $('#replacementBackground').value = style.background;
  $('#replacementColor').value = $('#matchOriginalInk').checked ? style.color : (style.observedColor || style.color);
  $('#replacementBold').checked = style.bold;
  $('#replacementSize').value = style.size;
  $('#replacementSizeValue').textContent = `${style.size}%`;
  syncTextPresetButtons();
}

function syncInkControlLabels() {
  $('#replacementOpacityValue').textContent = `${$('#replacementOpacity').value}%`;
  $('#replacementSoftnessValue').textContent = `${(Number($('#replacementSoftness').value) / 100).toFixed(1)}px`;
}

function applyMatchedInk(style) {
  if (!style) return;
  $('#replacementColor').value = style.color;
  $('#replacementOpacity').value = Math.max(25, Math.min(100, Math.round((style.opacity ?? 1) * 100)));
  $('#replacementSoftness').value = Math.max(0, Math.min(200, Math.round((style.softness ?? 0) * 100)));
  syncInkControlLabels();
}

const fontNames = { sans: '黑体', serif: '宋体', kai: '楷体', fang: '仿宋', mono: '等宽字体' };
const textStylePresets = {
  body: { name: '正文宋体', font: 'serif', size: 100, bold: false },
  table: { name: '表格小字', font: 'serif', size: 88, bold: false },
  heading: { name: '醒目标题', font: 'sans', size: 150, bold: true },
  fang: { name: '仿宋段落', font: 'fang', size: 133, bold: false },
  note: { name: '楷体说明', font: 'kai', size: 100, bold: false }
};

function syncTextPresetButtons(activeStyle = '') {
  const size = Number($('#replacementSize').value);
  document.querySelectorAll('[data-size-preset]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.sizePreset) === size);
  });
  document.querySelectorAll('[data-style-preset]').forEach((button) => {
    button.classList.toggle('active', button.dataset.stylePreset === activeStyle);
  });
}

function setReplacementSize(value) {
  $('#replacementSize').value = value;
  $('#replacementSizeValue').textContent = `${value}%`;
}

function ocrProgress(message) {
  const labels = {
    'loading tesseract core': '正在加载识别引擎',
    'loading language traineddata': '正在加载中文识别模型',
    'initializing api': '正在准备文字识别',
    'recognizing text': '正在识别选区文字'
  };
  const label = labels[message.status] || '正在准备自动识别';
  const progress = Math.round((message.progress || 0) * 100);
  const suffix = message.status === 'recognizing text' ? '' : '（可以先框选）';
  $('#ocrStatus').textContent = `${label} ${progress}%${suffix}`;
}

async function loadOcrWorker() {
  if (!ocrWorkerPromise) {
    const root = new URL('.', window.location.href);
    ocrWorkerPromise = Tesseract.createWorker('chi_sim', Tesseract.OEM.LSTM_ONLY, {
      workerPath: new URL('vendor/tesseract/worker.min.js', root).href,
      corePath: new URL('vendor/tesseract/core', root).href,
      langPath: new URL('models/ocr', root).href,
      logger: ocrProgress
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1'
      });
      return worker;
    }).catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function segmentPhoto(photo) {
  const edge = Number($('#edgeRefine').value);
  if (photo.cutout?.edge === edge) return photo.cutout;
  const image = await photo.imagePromise;
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const source = canvas2d(width, height);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0, width, height);

  if (!photo.segmentData) {
    const segmenter = await loadSegmenter();
    const inferenceScale = Math.min(1, 640 / Math.max(width, height));
    const inference = canvas2d(
      Math.max(1, Math.round(width * inferenceScale)),
      Math.max(1, Math.round(height * inferenceScale))
    );
    const inferenceContext = inference.getContext('2d');
    inferenceContext.imageSmoothingEnabled = true;
    inferenceContext.imageSmoothingQuality = 'high';
    inferenceContext.drawImage(source, 0, 0, inference.width, inference.height);
    const result = segmenter.segment(inference);
    const categoryMask = result.categoryMask;
    const maskWidth = categoryMask.width;
    const maskHeight = categoryMask.height;
    let confidence;
    if (result.confidenceMasks?.length) {
      const maskIndex = result.confidenceMasks.length > 1 ? 1 : 0;
      confidence = new Float32Array(result.confidenceMasks[maskIndex].getAsFloat32Array());
    } else {
      const values = categoryMask.getAsUint8Array();
      confidence = new Float32Array(values.length);
      for (let i = 0; i < values.length; i += 1) confidence[i] = values[i] ? 1 : 0;
    }
    photo.segmentData = { maskWidth, maskHeight, confidence };
    if (typeof result.close === 'function') result.close();
  }

  const { maskWidth, maskHeight, confidence } = photo.segmentData;
  const center = 0.40 + edge / 100 * 0.20;
  const feather = 0.23 - edge / 100 * 0.13;
  const low = center - feather;
  const high = center + feather;
  const allowed = foregroundRegion(confidence, maskWidth, maskHeight, Math.max(0.18, low - 0.08));
  const maskImage = new ImageData(maskWidth, maskHeight);
  for (let i = 0; i < confidence.length; i += 1) {
    let amount = allowed[i] ? Math.max(0, Math.min(1, (confidence[i] - low) / (high - low))) : 0;
    amount = amount * amount * (3 - 2 * amount);
    const a = Math.round(amount * 255);
    const offset = i * 4;
    maskImage.data[offset] = 255;
    maskImage.data[offset + 1] = 255;
    maskImage.data[offset + 2] = 255;
    maskImage.data[offset + 3] = a;
  }

  const maskCanvas = canvas2d(maskWidth, maskHeight);
  maskCanvas.getContext('2d').putImageData(maskImage, 0, 0);
  const refinedMask = canvas2d(width, height);
  const refinedContext = refinedMask.getContext('2d', { willReadFrequently: true });
  refinedContext.imageSmoothingEnabled = true;
  refinedContext.imageSmoothingQuality = 'high';
  refinedContext.drawImage(maskCanvas, 0, 0, width, height);
  const refined = refinedContext.getImageData(0, 0, width, height);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height);
  tightenMask(refined, width, height, edge, sourcePixels.data);
  const backgroundProfile = estimateBorderBackground(sourcePixels.data, refined.data, width, height);
  const spillData = suppressUniformBackgroundSpill(
    refined.data,
    sourcePixels.data,
    width,
    height,
    edge,
    backgroundProfile
  );
  const spillStrength = spillData?.strength || null;
  const edgeDepth = spillData?.edgeDepth || null;

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < width * height; i += 1) {
    if (refined.data[i * 4 + 3] > 12) {
      const x = i % width;
      const y = Math.floor(i / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('没有识别到清晰的人物主体');

  const sourceData = sourcePixels.data;
  const maskData = refined.data;
  const baseAlpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      let alpha = maskData[offset + 3];
      const depth = edgeDepth?.[pixel] ?? 255;
      const directionalCandidate = Boolean(backgroundProfile && depth > 0 && depth < 255);
      if (alpha > 2 && (alpha < 253 || directionalCandidate)) {
        const detectedSpill = (spillStrength?.[pixel] || 0) / 255;
        let foregroundAlpha = alpha;
        let foregroundOffset = -1;
        let foregroundScore = -1;
        let backgroundAlpha = alpha;
        let backgroundOffset = -1;
        const leftAlpha = maskData[(y * width + Math.max(0, x - 1)) * 4 + 3];
        const rightAlpha = maskData[(y * width + Math.min(width - 1, x + 1)) * 4 + 3];
        const topAlpha = maskData[(Math.max(0, y - 1) * width + x) * 4 + 3];
        const bottomAlpha = maskData[(Math.min(height - 1, y + 1) * width + x) * 4 + 3];
        let gradientX = rightAlpha - leftAlpha;
        let gradientY = bottomAlpha - topAlpha;
        let magnitude = Math.hypot(gradientX, gradientY);
        if (magnitude <= 0.5 && directionalCandidate) {
          const leftDepth = edgeDepth[y * width + Math.max(0, x - 1)];
          const rightDepth = edgeDepth[y * width + Math.min(width - 1, x + 1)];
          const topDepth = edgeDepth[Math.max(0, y - 1) * width + x];
          const bottomDepth = edgeDepth[Math.min(height - 1, y + 1) * width + x];
          gradientX = rightDepth - leftDepth;
          gradientY = bottomDepth - topDepth;
          magnitude = Math.hypot(gradientX, gradientY);
        }
        if (magnitude > 0.5) {
          const directionX = gradientX / magnitude;
          const directionY = gradientY / magnitude;
          const searchDistance = edge >= 70 ? 20 : 14;
          for (let step = 1; step <= searchDistance; step += 1) {
            const insideX = clamp(Math.round(x + directionX * step), 0, width - 1);
            const insideY = clamp(Math.round(y + directionY * step), 0, height - 1);
            const insideOffset = (insideY * width + insideX) * 4;
            const insideAlpha = maskData[insideOffset + 3];
            const cleanColorScore = backgroundProfile
              ? smoothStep(
                  backgroundProfile.tolerance * 1.2,
                  backgroundProfile.tolerance * 6,
                  Math.hypot(
                    sourceData[insideOffset] - backgroundProfile.color[0],
                    sourceData[insideOffset + 1] - backgroundProfile.color[1],
                    sourceData[insideOffset + 2] - backgroundProfile.color[2]
                  )
                )
              : 0;
            const insideScore = insideAlpha / 255 * 0.56
              + cleanColorScore * 0.40
              + step / searchDistance * 0.04;
            if (insideAlpha >= Math.max(90, alpha * 0.55) && insideScore > foregroundScore) {
              foregroundAlpha = insideAlpha;
              foregroundOffset = insideOffset;
              foregroundScore = insideScore;
            }
            const outsideX = clamp(Math.round(x - directionX * step), 0, width - 1);
            const outsideY = clamp(Math.round(y - directionY * step), 0, height - 1);
            const outsideOffset = (outsideY * width + outsideX) * 4;
            const outsideAlpha = maskData[outsideOffset + 3];
            if (outsideAlpha < backgroundAlpha) {
              backgroundAlpha = outsideAlpha;
              backgroundOffset = outsideOffset;
            }
          }
        }
        const hasMatteTransition = foregroundAlpha > alpha + 7;
        if (foregroundOffset >= 0 && (hasMatteTransition || directionalCandidate)) {
          const opacity = alpha / 255;
          const edgeAmount = smoothStep(0.05, 0.92, 1 - opacity);
          const confidence = hasMatteTransition
            ? smoothStep(0.06, 0.72, (foregroundAlpha - alpha) / 255)
            : 0;
          const observedColor = [sourceData[offset], sourceData[offset + 1], sourceData[offset + 2]];
          const localBackground = backgroundOffset >= 0 && backgroundAlpha < alpha - 5
            ? [
                sourceData[backgroundOffset],
                sourceData[backgroundOffset + 1],
                sourceData[backgroundOffset + 2]
              ]
            : null;
          const backgroundColor = localBackground || backgroundProfile?.color || null;
          const foregroundColor = [
            sourceData[foregroundOffset],
            sourceData[foregroundOffset + 1],
            sourceData[foregroundOffset + 2]
          ];
          let directionalSpill = 0;
          if (backgroundColor) {
            const backgroundVector = [
              backgroundColor[0] - foregroundColor[0],
              backgroundColor[1] - foregroundColor[1],
              backgroundColor[2] - foregroundColor[2]
            ];
            const observedVector = [
              observedColor[0] - foregroundColor[0],
              observedColor[1] - foregroundColor[1],
              observedColor[2] - foregroundColor[2]
            ];
            const denominator = backgroundVector[0] ** 2
              + backgroundVector[1] ** 2
              + backgroundVector[2] ** 2;
            if (denominator > 144) {
              const projection = (
                observedVector[0] * backgroundVector[0]
                + observedVector[1] * backgroundVector[1]
                + observedVector[2] * backgroundVector[2]
              ) / denominator;
              const projectedColor = [
                foregroundColor[0] + backgroundVector[0] * projection,
                foregroundColor[1] + backgroundVector[1] * projection,
                foregroundColor[2] + backgroundVector[2] * projection
              ];
              const residual = Math.hypot(
                observedColor[0] - projectedColor[0],
                observedColor[1] - projectedColor[1],
                observedColor[2] - projectedColor[2]
              ) / Math.sqrt(denominator);
              const alignment = 1 - smoothStep(0.10, 0.48, residual);
              const depthWeight = directionalCandidate
                ? 1 - smoothStep(spillData.radius * 0.45, spillData.radius + 0.5, depth)
                : 1;
              directionalSpill = clamp(projection, 0, 0.82) * alignment * depthWeight;
            }
          }
          const spillCorrection = smoothStep(0.005, 0.22, directionalSpill);
          const decontaminate = clamp(
            (0.54 + edge / 260) * edgeAmount * confidence
              + detectedSpill * 0.56
              + spillCorrection * 0.96,
            0,
            0.985
          );
          let backgroundAffinity = 0;
          if (backgroundColor && alpha < 225) {
            const observedDistance = Math.hypot(
              observedColor[0] - backgroundColor[0],
              observedColor[1] - backgroundColor[1],
              observedColor[2] - backgroundColor[2]
            );
            const foregroundDistance = Math.hypot(
              sourceData[foregroundOffset] - backgroundColor[0],
              sourceData[foregroundOffset + 1] - backgroundColor[1],
              sourceData[foregroundOffset + 2] - backgroundColor[2]
            );
            backgroundAffinity = 1 - smoothStep(0.14, 0.72, observedDistance / Math.max(8, foregroundDistance));
          }
          for (let channel = 0; channel < 3; channel += 1) {
            const observed = observedColor[channel];
            const foreground = foregroundColor[channel];
            let recovered = foreground;
            if (backgroundColor) {
              const background = backgroundColor[channel];
              const matteRecovered = (observed - (1 - opacity) * background) / Math.max(0.16, opacity);
              const spillRecovered = directionalSpill > 0.01
                ? (observed - directionalSpill * background) / Math.max(0.18, 1 - directionalSpill)
                : matteRecovered;
              recovered = clamp(spillRecovered, foreground - 96, foreground + 96) * 0.84 + foreground * 0.16;
            }
            sourceData[offset + channel] = observed * (1 - decontaminate) + recovered * decontaminate;
          }
          alpha *= 1
            - backgroundAffinity * (0.08 + edge / 100 * 0.16)
            - directionalSpill * (0.08 + edge / 100 * 0.13);
        }
      }
      sourceData[offset + 3] = alpha;
      baseAlpha[pixel] = alpha;
    }
  }
  decontaminateEdgeBand(sourcePixels, width, height, backgroundProfile, edge);
  for (let pixel = 0; pixel < baseAlpha.length; pixel += 1) {
    baseAlpha[pixel] = sourceData[pixel * 4 + 3];
  }

  const cutoutCanvas = canvas2d(width, height);
  const cutoutContext = cutoutCanvas.getContext('2d');
  cutoutContext.putImageData(sourcePixels, 0, 0);
  const basePixels = photo === photos[0] ? new Uint8ClampedArray(sourceData) : null;
  const padX = Math.round(width * 0.006);
  const padY = Math.round(height * 0.006);
  const bbox = {
    x: Math.max(0, minX - padX),
    y: Math.max(0, minY - padY),
    width: Math.min(width, maxX + 1 + padX) - Math.max(0, minX - padX),
    height: Math.min(height, maxY + 1 + padY) - Math.max(0, minY - padY)
  };
  photo.cutout = { canvas: cutoutCanvas, bbox, edge, baseAlpha, basePixels, backgroundProfile };
  return photo.cutout;
}

function drawBackground(context, canvas, background) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (background.type === 'transparent') return;
  if (background.type === 'color') {
    context.fillStyle = background.value;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const image = background.image;
  const ratio = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * ratio;
  const height = image.naturalHeight * ratio;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

async function primaryFaceForPhoto(photo, cutout) {
  if (Object.prototype.hasOwnProperty.call(photo, 'portraitFaceBox')) return photo.portraitFaceBox;
  const image = await photo.imagePromise;
  const faceSource = canvas2d(cutout.canvas.width, cutout.canvas.height);
  faceSource.getContext('2d').drawImage(image, 0, 0, faceSource.width, faceSource.height);
  const faces = await detectFaces(faceSource);
  photo.portraitFaceBox = faces.sort((first, second) => (
    second.width * second.height - first.width * first.height
  ))[0] || null;
  return photo.portraitFaceBox;
}

async function drawPersonComposition(photo, canvas, dimensions, preview = false) {
  const cutout = await segmentPhoto(photo);
  const background = currentBackground();
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  drawBackground(context, canvas, background);
  const bbox = cutout.bbox;
  const standardMode = Boolean(photoStandardState.id);
  const sideRatio = standardMode ? photoStandardState.sideRatio ?? 0.08 : 0.07;
  const topRatio = standardMode ? photoStandardState.topRatio ?? 0.08 : 0.07;
  let scale;
  let drawLeft;
  let drawTop;

  if (standardMode) {
    const face = await primaryFaceForPhoto(photo, cutout);
    if (face) {
      const headTop = clamp(face.y - face.height * 0.42, 0, cutout.canvas.height);
      const chin = clamp(face.y + face.height * 1.03, headTop + 1, cutout.canvas.height);
      const standard = photoStandards[photoStandardState.id];
      const desiredHeadHeight = canvas.height * (standard?.headRatio || 0.66);
      scale = desiredHeadHeight / Math.max(1, chin - headTop) * personState.scale;
      const maximumScaleByWidth = canvas.width * (1 - sideRatio * 2) / Math.max(1, bbox.width);
      scale = Math.min(scale, maximumScaleByWidth);
      drawLeft = canvas.width / 2
        - (face.x + face.width / 2) * scale
        + personState.x * canvas.width;
      drawTop = canvas.height * topRatio
        - headTop * scale
        + personState.y * canvas.height;
    } else {
      scale = Math.min(
        canvas.width * (1 - sideRatio * 2) / bbox.width,
        canvas.height * (1 - topRatio) / bbox.height
      ) * personState.scale;
      const subjectWidth = bbox.width * scale;
      const subjectLeft = (canvas.width - subjectWidth) / 2 + personState.x * canvas.width;
      const subjectTop = canvas.height * topRatio + personState.y * canvas.height;
      drawLeft = subjectLeft - bbox.x * scale;
      drawTop = subjectTop - bbox.y * scale;
    }
  } else {
    scale = Math.max(
      canvas.width / cutout.canvas.width,
      canvas.height / cutout.canvas.height
    ) * personState.scale;
    drawLeft = (canvas.width - cutout.canvas.width * scale) / 2 + personState.x * canvas.width;
    drawTop = (canvas.height - cutout.canvas.height * scale) / 2 + personState.y * canvas.height;
  }

  context.drawImage(
    cutout.canvas,
    0,
    0,
    cutout.canvas.width,
    cutout.canvas.height,
    drawLeft,
    drawTop,
    cutout.canvas.width * scale,
    cutout.canvas.height * scale
  );
  const left = drawLeft + bbox.x * scale;
  const top = drawTop + bbox.y * scale;
  const width = bbox.width * scale;
  const height = bbox.height * scale;
  if (preview) {
    previewMetrics = {
      left, top, width, height,
      right: canvas.width - left - width,
      bottom: canvas.height - top - height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
      bbox
    };
    updateMarginInputs();
  }
}

function updateMarginInputs() {
  if (!previewMetrics) return;
  const xRatio = previewMetrics.outputWidth / previewMetrics.canvasWidth;
  const yRatio = previewMetrics.outputHeight / previewMetrics.canvasHeight;
  $('#marginTop').value = Math.round(previewMetrics.top * yRatio);
  $('#marginBottom').value = Math.round(previewMetrics.bottom * yRatio);
  $('#marginLeft').value = Math.round(previewMetrics.left * xRatio);
  $('#marginRight').value = Math.round(previewMetrics.right * xRatio);
}

async function renderEditor() {
  const token = ++renderToken;
  if (!$('#personEnabled').checked || !photos.length) return;
  try {
    $('#personStatus').textContent = '正在识别人物，请稍候…';
    const image = await photos[0].imagePromise;
    const dimensions = outputDimensions(image);
    const previewScale = Math.min(4, 720 / dimensions.width, 620 / dimensions.height);
    editorCanvas.width = Math.max(1, Math.round(dimensions.width * previewScale));
    editorCanvas.height = Math.max(1, Math.round(dimensions.height * previewScale));
    await drawPersonComposition(photos[0], editorCanvas, dimensions, true);
    if (token !== renderToken) return;
    $('#personStatus').textContent = photos[0].cutout?.backgroundProfile
      ? '人物已识别；已清理原底色边缘，可继续拖动微调'
      : '人物已识别；拖动人物或调整下面的数值';
  } catch (error) {
    console.error(error);
    $('#personStatus').textContent = error.message || '人物识别失败，请换一张照片重试';
    editorContext.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  }
}

let editorTimer;
function scheduleEditorRender() {
  clearTimeout(editorTimer);
  editorTimer = setTimeout(renderEditor, 80);
}

$('#personEnabled').addEventListener('change', () => {
  $('#portraitPanel').hidden = !$('#personEnabled').checked;
  refreshResolvedNames();
  if ($('#personEnabled').checked) renderEditor();
  scheduleQuickPreview();
});

document.querySelectorAll('input[name="personBg"]').forEach((input) => input.addEventListener('change', () => {
  customBackgroundActive = false;
  backgroundImage = null;
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = '';
  $('#clearBackground').hidden = true;
  refreshResolvedNames();
  scheduleEditorRender();
}));

$('#customBgColor').addEventListener('input', () => {
  customBackgroundActive = true;
  backgroundImage = null;
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = '';
  $('#clearBackground').hidden = true;
  refreshResolvedNames();
  scheduleEditorRender();
});

$('#backgroundPicker').addEventListener('change', async () => {
  const file = $('#backgroundPicker').files[0];
  $('#backgroundPicker').value = '';
  if (!file || !isImage(file)) return flash('请选择一张背景图片');
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = URL.createObjectURL(file);
  try {
    backgroundImage = await imageFromUrl(backgroundUrl);
    customBackgroundActive = false;
    $('#clearBackground').hidden = false;
    refreshResolvedNames();
    renderEditor();
  } catch {
    flash('背景图片无法读取');
  }
});

$('#clearBackground').addEventListener('click', () => {
  backgroundImage = null;
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = '';
  $('#clearBackground').hidden = true;
  scheduleEditorRender();
});

$('#personScale').addEventListener('input', () => {
  personState.scale = Number($('#personScale').value) / 100;
  $('#scaleValue').textContent = `${$('#personScale').value}%`;
  scheduleEditorRender();
});

$('#edgeRefine').addEventListener('input', () => {
  const value = Number($('#edgeRefine').value);
  $('#edgeValue').textContent = value < 36 ? '柔和' : value < 75 ? '干净自然' : '发丝去色溢';
  photos.forEach((photo) => { photo.cutout = null; });
  scheduleEditorRender();
});

$('#resetPerson').addEventListener('click', () => {
  personState.scale = 1;
  personState.x = 0;
  personState.y = 0;
  $('#personScale').value = 100;
  $('#scaleValue').textContent = '100%';
  scheduleEditorRender();
});

function setMargin(side, value) {
  if (!previewMetrics || !Number.isFinite(value)) return;
  const xRatio = previewMetrics.outputWidth / previewMetrics.canvasWidth;
  const yRatio = previewMetrics.outputHeight / previewMetrics.canvasHeight;
  if (side === 'left') personState.x += (value / xRatio - previewMetrics.left) / previewMetrics.canvasWidth;
  if (side === 'right') personState.x += (previewMetrics.right - value / xRatio) / previewMetrics.canvasWidth;
  if (side === 'top') personState.y += (value / yRatio - previewMetrics.top) / previewMetrics.canvasHeight;
  if (side === 'bottom') personState.y += (previewMetrics.bottom - value / yRatio) / previewMetrics.canvasHeight;
  scheduleEditorRender();
}

[['#marginTop', 'top'], ['#marginBottom', 'bottom'], ['#marginLeft', 'left'], ['#marginRight', 'right']].forEach(([selector, side]) => {
  $(selector).addEventListener('change', () => setMargin(side, Number($(selector).value)));
});

document.querySelectorAll('[data-brush-mode]').forEach((button) => button.addEventListener('click', () => {
  brushMode = button.dataset.brushMode;
  document.querySelectorAll('[data-brush-mode]').forEach((item) => item.classList.toggle('active', item === button));
  editorCanvas.classList.toggle('brush', brushMode !== 'move');
}));

$('#brushSize').addEventListener('input', () => { $('#brushValue').textContent = $('#brushSize').value; });

function paintPersonEdge(event) {
  const photo = photos[0];
  const cutout = photo?.cutout;
  if (!cutout || !previewMetrics || brushMode === 'move') return;
  const rect = editorCanvas.getBoundingClientRect();
  const canvasX = (event.clientX - rect.left) * editorCanvas.width / rect.width;
  const canvasY = (event.clientY - rect.top) * editorCanvas.height / rect.height;
  const relativeX = (canvasX - previewMetrics.left) / previewMetrics.width;
  const relativeY = (canvasY - previewMetrics.top) / previewMetrics.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return;
  const sourceX = previewMetrics.bbox.x + relativeX * previewMetrics.bbox.width;
  const sourceY = previewMetrics.bbox.y + relativeY * previewMetrics.bbox.height;
  const previewRadius = Number($('#brushSize').value) * editorCanvas.width / rect.width / 2;
  const radius = Math.max(2, previewRadius / previewMetrics.width * previewMetrics.bbox.width);
  const left = Math.max(0, Math.floor(sourceX - radius));
  const top = Math.max(0, Math.floor(sourceY - radius));
  const right = Math.min(cutout.canvas.width, Math.ceil(sourceX + radius));
  const bottom = Math.min(cutout.canvas.height, Math.ceil(sourceY + radius));
  const width = right - left;
  const height = bottom - top;
  if (!width || !height) return;
  const context = cutout.canvas.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(left, top, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const globalX = left + x;
      const globalY = top + y;
      const distance = Math.hypot(globalX - sourceX, globalY - sourceY);
      if (distance > radius) continue;
      const strength = Math.pow(1 - distance / radius, 0.65);
      const localOffset = (y * width + x) * 4;
      const globalPixel = globalY * cutout.canvas.width + globalX;
      if (brushMode === 'erase') {
        pixels.data[localOffset + 3] = Math.max(0, pixels.data[localOffset + 3] * (1 - strength * 0.9));
      } else {
        const targetAlpha = cutout.baseAlpha[globalPixel];
        pixels.data[localOffset + 3] += (targetAlpha - pixels.data[localOffset + 3]) * strength;
        if (cutout.basePixels) {
          const baseOffset = globalPixel * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            pixels.data[localOffset + channel] += (cutout.basePixels[baseOffset + channel] - pixels.data[localOffset + channel]) * strength;
          }
        }
      }
    }
  }
  context.putImageData(pixels, left, top);
  scheduleEditorRender();
}

editorCanvas.addEventListener('pointerdown', (event) => {
  editorCanvas.setPointerCapture(event.pointerId);
  if (brushMode === 'move') dragging = { x: event.clientX, y: event.clientY };
  else { brushDrawing = true; paintPersonEdge(event); }
});

editorCanvas.addEventListener('pointermove', (event) => {
  if (brushDrawing) return paintPersonEdge(event);
  if (!dragging) return;
  const rect = editorCanvas.getBoundingClientRect();
  personState.x += (event.clientX - dragging.x) / rect.width;
  personState.y += (event.clientY - dragging.y) / rect.height;
  dragging = { x: event.clientX, y: event.clientY };
  scheduleEditorRender();
});

['pointerup', 'pointercancel'].forEach((type) => editorCanvas.addEventListener(type, () => {
  dragging = null;
  brushDrawing = false;
}));

$('#openRemoveEditor').addEventListener('click', () => openRemoveEditor(photos[0]));
$('#closeRemoveEditor').addEventListener('click', closeRemoveEditor);

removeEditCanvas.addEventListener('pointerdown', (event) => {
  removeSelectionStart = pointerOnRemoveCanvas(event);
  removeSelection = { ...removeSelectionStart, width: 0, height: 0 };
  removeEditCanvas.setPointerCapture(event.pointerId);
  renderRemoveEditorCanvas();
});

removeEditCanvas.addEventListener('pointermove', (event) => {
  if (!removeSelectionStart) return;
  const point = pointerOnRemoveCanvas(event);
  removeSelection = {
    x: Math.min(removeSelectionStart.x, point.x),
    y: Math.min(removeSelectionStart.y, point.y),
    width: Math.abs(point.x - removeSelectionStart.x),
    height: Math.abs(point.y - removeSelectionStart.y)
  };
  renderRemoveEditorCanvas();
});

['pointerup', 'pointercancel'].forEach((type) => removeEditCanvas.addEventListener(type, () => {
  removeSelectionStart = null;
  if (removeSelection?.width >= 5 && removeSelection?.height >= 5) {
    $('#removeStatus').textContent = '选区完成，可以智能去除';
  }
  syncRemoveActions();
}));

$('#clearRemoveSelection').addEventListener('click', () => {
  removeSelection = null;
  $('#removeStatus').textContent = '请重新框选需要去除的区域';
  renderRemoveEditorCanvas();
});

$('#applySmartRemove').addEventListener('click', () => {
  const photo = activeRemovePhoto();
  if (!photo || !removeSelection || removeSelection.width < 5 || removeSelection.height < 5) return;
  photo.removals ||= [];
  photo.removals.push({
    x: removeSelection.x / removeEditCanvas.width,
    y: removeSelection.y / removeEditCanvas.height,
    width: removeSelection.width / removeEditCanvas.width,
    height: removeSelection.height / removeEditCanvas.height,
    backgroundColor: sampledBackground(removeEditorOriginal, removeSelection)
  });
  removeSelection = null;
  $('#removeStatus').textContent = '已去除；复杂背景可以分成几个小区域继续处理';
  renderRemoveEditorCanvas();
  scheduleQuickPreview();
  refreshResolvedNames();
  flash('已完成局部去除');
});

$('#undoSmartRemove').addEventListener('click', () => {
  const photo = activeRemovePhoto();
  if (!photo?.removals?.length) return;
  photo.removals.pop();
  renderRemoveEditorCanvas();
  scheduleQuickPreview();
  refreshResolvedNames();
  flash('已撤销上一次去除');
});

$('#openTextEditor').addEventListener('click', () => openTextEditor(photos[0]));
$('#closeTextEditor').addEventListener('click', closeTextEditor);

textEditCanvas.addEventListener('pointerdown', (event) => {
  textSelectionStart = pointerOnTextCanvas(event);
  textSelection = { ...textSelectionStart, width: 0, height: 0 };
  textEditCanvas.setPointerCapture(event.pointerId);
  renderTextEditorCanvas();
});

textEditCanvas.addEventListener('pointermove', (event) => {
  if (!textSelectionStart) return;
  const point = pointerOnTextCanvas(event);
  textSelection = {
    x: Math.min(textSelectionStart.x, point.x),
    y: Math.min(textSelectionStart.y, point.y),
    width: Math.abs(point.x - textSelectionStart.x),
    height: Math.abs(point.y - textSelectionStart.y)
  };
  renderTextEditorCanvas();
});

['pointerup', 'pointercancel'].forEach((type) => textEditCanvas.addEventListener(type, () => {
  textSelectionStart = null;
  if (textSelection?.width >= 5 && textSelection?.height >= 5 && textEditorOriginal) {
    recognizedSourceText = '';
    const style = analyzeSelectionStyle(textEditorOriginal, textSelection);
    matchedTextStyle = style;
    $('#replacementBackground').value = style.background;
    if ($('#matchOriginalStyle').checked) {
      applyBasicMatchedStyle(style);
      $('#replacementFont').value = 'auto';
    }
    if ($('#matchOriginalInk').checked) applyMatchedInk(style);
    $('#styleMatchStatus').textContent = $('#matchOriginalInk').checked
      ? `已读取原文字墨迹：浓淡 ${$('#replacementOpacity').value}%、柔和 ${$('#replacementSoftnessValue').textContent}`
      : '已读取原文字颜色与粗细；自动识别后会继续匹配字体';
    $('#ocrStatus').textContent = '选区完成：直接输入新文字，或让它先自动识别';
  }
  syncTextEditorActions();
}));

$('#clearTextSelection').addEventListener('click', () => {
  textSelection = null;
  matchedTextStyle = null;
  recognizedSourceText = '';
  $('#replacementFont').value = 'auto';
  $('#replacementOpacity').value = 100;
  $('#replacementSoftness').value = 0;
  syncInkControlLabels();
  $('#styleMatchStatus').textContent = '识别原文字后会自动匹配最接近的样式';
  $('#ocrStatus').textContent = '请重新在图片上框选文字';
  renderTextEditorCanvas();
});

$('#replacementText').addEventListener('input', syncTextEditorActions);

$('#matchOriginalStyle').addEventListener('change', () => {
  if ($('#matchOriginalStyle').checked && matchedTextStyle) {
    applyBasicMatchedStyle(matchedTextStyle);
    $('#replacementFont').value = matchedTextStyle.font || 'auto';
  }
});

$('#matchOriginalInk').addEventListener('change', () => {
  if ($('#matchOriginalInk').checked && matchedTextStyle) {
    applyMatchedInk(matchedTextStyle);
  } else if (matchedTextStyle) {
    $('#replacementColor').value = matchedTextStyle.observedColor || matchedTextStyle.color;
    $('#replacementOpacity').value = 100;
    $('#replacementSoftness').value = 0;
    syncInkControlLabels();
  }
});

$('#replacementOpacity').addEventListener('input', () => {
  $('#matchOriginalInk').checked = false;
  syncInkControlLabels();
});

$('#replacementSoftness').addEventListener('input', () => {
  $('#matchOriginalInk').checked = false;
  syncInkControlLabels();
});

$('#replacementSize').addEventListener('input', () => {
  $('#replacementSizeValue').textContent = `${$('#replacementSize').value}%`;
  syncTextPresetButtons();
});

$('#textPresetPanel').addEventListener('click', (event) => {
  const sizeButton = event.target.closest('[data-size-preset]');
  if (sizeButton) {
    setReplacementSize(Number(sizeButton.dataset.sizePreset));
    syncTextPresetButtons();
    $('#styleMatchStatus').textContent = `已选择 ${sizeButton.textContent.replace(/\s+/g, ' ').trim()}，可继续微调`;
    return;
  }
  const styleButton = event.target.closest('[data-style-preset]');
  if (!styleButton) return;
  const preset = textStylePresets[styleButton.dataset.stylePreset];
  if (!preset) return;
  $('#replacementFont').value = preset.font;
  $('#replacementBold').checked = preset.bold;
  $('#matchOriginalStyle').checked = false;
  setReplacementSize(preset.size);
  syncTextPresetButtons(styleButton.dataset.stylePreset);
  $('#styleMatchStatus').textContent = `已使用“${preset.name}”，字号和粗细仍可调整`;
});

$('#replacementFont').addEventListener('change', () => {
  if ($('#replacementFont').value !== 'auto') $('#matchOriginalStyle').checked = false;
  syncTextPresetButtons();
});

$('#replacementBold').addEventListener('change', () => {
  $('#matchOriginalStyle').checked = false;
  syncTextPresetButtons();
});

$('#recognizeSelection').addEventListener('click', async () => {
  if (!textEditorOriginal || !textSelection || textSelection.width < 5 || textSelection.height < 5) return flash('请先在图片上框选文字区域');
  const button = $('#recognizeSelection');
  button.disabled = true;
  try {
    const maxDimension = Math.max(textSelection.width, textSelection.height);
    const scale = Math.max(1, Math.min(4, 2000 / maxDimension));
    const ocrCanvas = canvas2d(
      Math.max(1, Math.round(textSelection.width * scale)),
      Math.max(1, Math.round(textSelection.height * scale))
    );
    const context = ocrCanvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      textEditorOriginal,
      textSelection.x, textSelection.y, textSelection.width, textSelection.height,
      0, 0, ocrCanvas.width, ocrCanvas.height
    );
    const pixels = context.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
    const background = $('#replacementBackground').value;
    const backgroundLight = Number.parseInt(background.slice(1, 3), 16) * 0.299
      + Number.parseInt(background.slice(3, 5), 16) * 0.587
      + Number.parseInt(background.slice(5, 7), 16) * 0.114;
    const histogram = new Uint32Array(256);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const gray = Math.max(0, Math.min(255, Math.round(
        pixels.data[offset] * 0.299 + pixels.data[offset + 1] * 0.587 + pixels.data[offset + 2] * 0.114
      )));
      histogram[gray] += 1;
    }
    const percentile = (ratio) => {
      const target = (pixels.data.length / 4) * ratio;
      let total = 0;
      for (let value = 0; value < histogram.length; value += 1) {
        total += histogram[value];
        if (total >= target) return value;
      }
      return 255;
    };
    const shadow = percentile(0.06);
    const highlight = Math.max(shadow + 24, percentile(0.94));
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      let gray = pixels.data[offset] * 0.299 + pixels.data[offset + 1] * 0.587 + pixels.data[offset + 2] * 0.114;
      gray = Math.max(0, Math.min(255, (gray - shadow) * 255 / (highlight - shadow)));
      if (backgroundLight < 110) gray = 255 - gray;
      pixels.data[offset] = gray;
      pixels.data[offset + 1] = gray;
      pixels.data[offset + 2] = gray;
    }
    context.putImageData(pixels, 0, 0);
    const worker = await loadOcrWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: textSelection.width / Math.max(1, textSelection.height) > 2.2 ? '7' : '6',
      preserve_interword_spaces: '1'
    });
    const result = await worker.recognize(ocrCanvas);
    const recognized = String(result.data.text || '')
      .trim()
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
      .replace(/\n{3,}/g, '\n\n');
    if (!recognized) {
      $('#ocrStatus').textContent = '没有识别到文字，可以直接输入新内容';
      flash('没有识别到清晰文字，请扩大选区或直接输入');
    } else {
      recognizedSourceText = recognized;
      $('#replacementText').value = recognized;
      if ($('#matchOriginalStyle').checked) {
        const baseStyle = matchedTextStyle || analyzeSelectionStyle(textEditorOriginal, textSelection);
        const matchedFont = await detectClosestFont(textEditorOriginal, textSelection, recognizedSourceText, baseStyle);
        const sourceCharacterCount = Math.max(1, Array.from(recognizedSourceText.replace(/\s/g, '')).length);
        matchedTextStyle = {
          ...baseStyle,
          font: matchedFont.font,
          bold: matchedFont.bold,
          layout: {
            ...baseStyle.layout,
            advanceRatio: (baseStyle.layout?.glyphWidthRatio || 0.92) / sourceCharacterCount
          }
        };
        applyBasicMatchedStyle(matchedTextStyle);
        if ($('#matchOriginalInk').checked) applyMatchedInk(matchedTextStyle);
        $('#replacementFont').value = matchedFont.font;
        $('#styleMatchStatus').textContent = `已自动匹配：${fontNames[matchedFont.font]}、${matchedFont.bold ? '加粗' : '常规'}、墨迹 ${$('#replacementOpacity').value}%`;
        $('#ocrStatus').textContent = '识别完成，并已匹配接近原图的字体、颜色与墨迹';
      } else {
        $('#ocrStatus').textContent = '识别完成，请检查并修改文字';
      }
      syncTextEditorActions();
    }
  } catch (error) {
    console.error(error);
    $('#ocrStatus').textContent = '识别失败，请直接输入文字或稍后重试';
    flash('文字识别失败，请检查网络后重试');
  } finally {
    syncTextEditorActions();
  }
});

$('#applyTextReplacement').addEventListener('click', () => {
  const photo = activeTextPhoto();
  const text = $('#replacementText').value.trim();
  if (!photo || !textSelection || textSelection.width < 5 || textSelection.height < 5) return flash('请先框选需要修改的文字区域');
  if (!text) return flash('请输入替换后的文字');
  const backgroundColor = sampledBackground(textEditorOriginal, textSelection);
  $('#replacementBackground').value = backgroundColor;
  const selectedFont = $('#replacementFont').value === 'auto'
    ? (matchedTextStyle?.font || 'sans')
    : $('#replacementFont').value;
  photo.textEdits.push({
    x: textSelection.x / textEditCanvas.width,
    y: textSelection.y / textEditCanvas.height,
    width: textSelection.width / textEditCanvas.width,
    height: textSelection.height / textEditCanvas.height,
    text,
    sourceText: recognizedSourceText || text,
    font: selectedFont,
    size: Number($('#replacementSize').value),
    baseSize: matchedTextStyle?.size || 100,
    layout: matchedTextStyle?.layout ? { ...matchedTextStyle.layout } : null,
    color: $('#replacementColor').value,
    opacity: Number($('#replacementOpacity').value) / 100,
    softnessRatio: (Number($('#replacementSoftness').value) / 100) / Math.max(1, textSelection.height),
    backgroundColor,
    backgroundMode: $('#autoReplacementBackground').checked ? 'smart' : 'solid',
    bold: $('#replacementBold').checked,
    correctionMode: true
  });
  textSelection = null;
  $('#replacementText').value = '';
  $('#ocrStatus').textContent = '已经替换。还要修改其他位置，可以继续框选';
  renderTextEditorCanvas();
  scheduleQuickPreview();
  refreshResolvedNames();
  flash('校正已应用，导出时会保留“已编辑 · 校正版”标识');
});

$('#undoTextReplacement').addEventListener('click', () => {
  const photo = activeTextPhoto();
  if (!photo?.textEdits.length) return;
  photo.textEdits.pop();
  renderTextEditorCanvas();
  scheduleQuickPreview();
  refreshResolvedNames();
  flash('已撤销上一次改字');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#textEditPanel').hidden) closeTextEditor();
  if (event.key === 'Escape' && !$('#removeEditorPanel').hidden) closeRemoveEditor();
});

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片生成失败')), type, quality));
}

function transformedCanvas(source) {
  const rotation = ((transformState.rotation % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  const rotated = canvas2d(swapped ? source.height : source.width, swapped ? source.width : source.height);
  const context = rotated.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(rotated.width / 2, rotated.height / 2);
  if (transformState.flipHorizontal) context.scale(-1, 1);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);

  if ($('#cropRatio').value === 'original') return rotated;
  const ratio = Number($('#cropRatio').value);
  let cropWidth = rotated.width;
  let cropHeight = rotated.height;
  if (rotated.width / rotated.height > ratio) cropWidth = Math.round(rotated.height * ratio);
  else cropHeight = Math.round(rotated.width / ratio);
  const x = Math.round((rotated.width - cropWidth) * Number($('#cropX').value) / 100);
  const y = Math.round((rotated.height - cropHeight) * Number($('#cropY').value) / 100);
  const cropped = canvas2d(cropWidth, cropHeight);
  cropped.getContext('2d').drawImage(rotated, x, y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return cropped;
}

function resizedCanvas(source) {
  if (!$('#resizeEnabled').checked) return source;
  const dimensions = outputDimensions(source);
  if (dimensions.width === source.width && dimensions.height === source.height) return source;
  const resized = canvas2d(dimensions.width, dimensions.height);
  const context = resized.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
  return resized;
}

async function loadFaceDetector() {
  if (!faceDetectorPromise) {
    faceDetectorPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe');
      return FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: './models/blaze_face_short_range.tflite' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.55
      });
    })();
  }
  return faceDetectorPromise;
}

async function detectFaces(source) {
  try {
    const maxSide = Math.max(source.width, source.height);
    const scale = Math.min(1, 720 / Math.max(1, maxSide));
    const input = scale < 1
      ? canvas2d(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
      : source;
    if (input !== source) input.getContext('2d').drawImage(source, 0, 0, input.width, input.height);
    const detector = await loadFaceDetector();
    const result = detector.detect(input);
    const scaleX = source.width / input.width;
    const scaleY = source.height / input.height;
    return (result.detections || []).slice(0, 8).map((detection) => {
      const box = detection.boundingBox || {};
      const points = (detection.keypoints || []).map((point) => ({
        x: point.x * source.width,
        y: point.y * source.height
      }));
      return {
        x: (box.originX || 0) * scaleX,
        y: (box.originY || 0) * scaleY,
        width: (box.width || 0) * scaleX,
        height: (box.height || 0) * scaleY,
        points
      };
    }).filter((face) => face.width > 12 && face.height > 12);
  } catch (error) {
    console.warn('Face detection unavailable', error);
    return [];
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothStep(start, end, value) {
  const amount = clamp((value - start) / Math.max(0.0001, end - start), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function ellipseMask(x, y, centerX, centerY, radiusX, radiusY) {
  const distance = Math.hypot((x - centerX) / Math.max(1, radiusX), (y - centerY) / Math.max(1, radiusY));
  return 1 - smoothStep(0.70, 1, distance);
}

function preparedFaceMasks(faces, data, width, height, strength) {
  return faces.map((face) => {
    const left = clamp(face.x - face.width * 0.08, 0, width);
    const right = clamp(face.x + face.width * 1.08, 0, width);
    const top = clamp(face.y - face.height * 0.08, 0, height);
    const bottom = clamp(face.y + face.height * 1.12, 0, height);
    const centerX = face.x + face.width * 0.5;
    const centerY = face.y + face.height * 0.53;
    const eyeLeft = face.points[0] || { x: face.x + face.width * 0.32, y: face.y + face.height * 0.39 };
    const eyeRight = face.points[1] || { x: face.x + face.width * 0.68, y: face.y + face.height * 0.39 };
    const nose = face.points[2] || { x: centerX, y: face.y + face.height * 0.59 };
    const mouth = face.points[3] || { x: centerX, y: face.y + face.height * 0.76 };
    let luminanceTotal = 0;
    let luminanceCount = 0;
    const step = Math.max(1, Math.round(Math.max(width, height) / 720));
    for (let y = Math.round(face.y + face.height * 0.42); y < Math.round(face.y + face.height * 0.72); y += step) {
      for (let x = Math.round(face.x + face.width * 0.22); x < Math.round(face.x + face.width * 0.78); x += step) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const offset = (y * width + x) * 4;
        luminanceTotal += data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
        luminanceCount += 1;
      }
    }
    const average = luminanceCount ? luminanceTotal / luminanceCount : 138;
    return {
      ...face, left, right, top, bottom, centerX, centerY, eyeLeft, eyeRight, nose, mouth,
      lift: clamp((142 - average) * 0.16, 0.8, 7.5) * strength
    };
  });
}

function faceSkinMask(x, y, face) {
  if (x < face.left || x > face.right || y < face.top || y > face.bottom) return 0;
  const faceShape = ellipseMask(x, y, face.centerX, face.centerY, face.width * 0.54, face.height * 0.59);
  if (faceShape <= 0) return 0;
  const eyeRadiusX = face.width * 0.14;
  const eyeRadiusY = face.height * 0.105;
  const eyeProtection = Math.max(
    ellipseMask(x, y, face.eyeLeft.x, face.eyeLeft.y, eyeRadiusX, eyeRadiusY),
    ellipseMask(x, y, face.eyeRight.x, face.eyeRight.y, eyeRadiusX, eyeRadiusY)
  );
  const mouthProtection = ellipseMask(x, y, face.mouth.x, face.mouth.y, face.width * 0.18, face.height * 0.095);
  const noseProtection = ellipseMask(x, y, face.nose.x, face.nose.y, face.width * 0.105, face.height * 0.13);
  const featureProtection = Math.max(eyeProtection, mouthProtection, noseProtection * 0.45);
  return faceShape * (1 - featureProtection * 0.94);
}

async function adjustedCanvas(source) {
  const brightness = Number($('#brightness').value);
  const contrast = Number($('#contrast').value);
  const saturation = Number($('#saturation').value);
  const vibrance = Number($('#vibrance').value);
  const warmth = Number($('#warmth').value);
  const tint = Number($('#tint').value);
  const highlights = Number($('#highlights').value);
  const shadows = Number($('#shadows').value);
  const fade = Number($('#fade').value);
  const vignette = Number($('#vignette').value);
  const sharpen = Number($('#sharpen').value);
  const shadowTeal = Number($('#shadowTeal').value);
  const highlightWarm = Number($('#highlightWarm').value);
  const filmGrain = Number($('#filmGrain').value);
  const clarityAmount = Number($('#clarityAmount').value);
  const beautyAmount = Number($('#beautyAmount').value);
  if (![brightness, contrast, saturation, vibrance, warmth, tint, highlights, shadows, fade, vignette, sharpen, shadowTeal, highlightWarm, filmGrain, clarityAmount, beautyAmount].some(Boolean)) return source;
  const canvas = canvas2d(source.width, source.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const light = brightness * 2.1;
  const color = 1 + saturation / 50;
  const temperature = warmth * 1.25;
  const tintShift = tint * 0.72;
  const fadeAmount = fade / 150;
  const contrastValue = contrast * 2.2;
  const contrastFactor = (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));
  for (let offset = 0; offset < data.length; offset += 4) {
    let red = contrastFactor * (data[offset] - 128) + 128 + light + temperature + tintShift * 0.45;
    let green = contrastFactor * (data[offset + 1] - 128) + 128 + light - tintShift * 0.55;
    let blue = contrastFactor * (data[offset + 2] - 128) + 128 + light - temperature + tintShift * 0.45;
    let gray = red * 0.299 + green * 0.587 + blue * 0.114;
    const tonalShift = shadows * 1.55 * Math.pow(1 - Math.max(0, Math.min(1, gray / 255)), 2)
      + highlights * 1.55 * Math.pow(Math.max(0, Math.min(1, gray / 255)), 2);
    red += tonalShift; green += tonalShift; blue += tonalShift;
    gray = red * 0.299 + green * 0.587 + blue * 0.114;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    const vibranceFactor = 1 + vibrance / 50 * (1 - Math.max(0, Math.min(1, chroma / 150))) * 0.68;
    red = gray + (red - gray) * color * vibranceFactor;
    green = gray + (green - gray) * color * vibranceFactor;
    blue = gray + (blue - gray) * color * vibranceFactor;
    const normalizedLight = Math.max(0, Math.min(1, gray / 255));
    const shadowWeight = Math.pow(1 - normalizedLight, 1.65);
    const highlightWeight = Math.pow(normalizedLight, 1.65);
    red += -shadowTeal * 0.44 * shadowWeight + highlightWarm * 0.58 * highlightWeight;
    green += shadowTeal * 0.18 * shadowWeight + highlightWarm * 0.16 * highlightWeight;
    blue += shadowTeal * 0.54 * shadowWeight - highlightWarm * 0.38 * highlightWeight;
    if (fadeAmount > 0) {
      red = red * (1 - fadeAmount) + 128 * fadeAmount;
      green = green * (1 - fadeAmount) + 128 * fadeAmount;
      blue = blue * (1 - fadeAmount) + 128 * fadeAmount;
    }
    if (vignette > 0) {
      const pixel = offset / 4;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      const dx = (x / Math.max(1, canvas.width - 1) - 0.5) * 2;
      const dy = (y / Math.max(1, canvas.height - 1) - 0.5) * 2;
      const edgeDistance = Math.max(0, (Math.hypot(dx, dy) - 0.35) / 1.06);
      const shade = 1 - Math.min(0.42, edgeDistance * edgeDistance * vignette / 95);
      red *= shade; green *= shade; blue *= shade;
    }
    if (filmGrain > 0) {
      const pixel = offset / 4;
      const noise = (((pixel * 1103515245 + 12345) >>> 16) & 255) / 255 - 0.5;
      red += noise * filmGrain * 1.25;
      green += noise * filmGrain * 1.05;
      blue += noise * filmGrain * 1.2;
    }
    data[offset] = Math.max(0, Math.min(255, red));
    data[offset + 1] = Math.max(0, Math.min(255, green));
    data[offset + 2] = Math.max(0, Math.min(255, blue));
  }
  const needsLocalDetail = beautyAmount > 0 || clarityAmount > 0 || sharpen > 0;
  if (needsLocalDetail && canvas.width > 2 && canvas.height > 2) {
    context.putImageData(pixels, 0, 0);
    const beautyStrength = clamp(beautyAmount / 100, 0, 1);
    const clarityStrength = clamp(clarityAmount / 100, 0, 1);
    const faces = beautyAmount > 0 ? await detectFaces(canvas) : [];
    const preparedFaces = preparedFaceMasks(faces, data, canvas.width, canvas.height, beautyStrength);
    const radius = clamp(Math.min(canvas.width, canvas.height) / 620, 1.15, 3.6);
    const blurred = canvas2d(canvas.width, canvas.height);
    const blurredContext = blurred.getContext('2d', { willReadFrequently: true });
    blurredContext.filter = `blur(${radius.toFixed(2)}px)`;
    blurredContext.drawImage(canvas, 0, 0);
    blurredContext.filter = 'none';
    const smooth = blurredContext.getImageData(0, 0, canvas.width, canvas.height).data;
    const widthStride = canvas.width * 4;
    const manualSharpness = sharpen / 50;
    for (let y = 1; y < canvas.height - 1; y += 1) {
      for (let x = 1; x < canvas.width - 1; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const originalRed = data[offset];
        const originalGreen = data[offset + 1];
        const originalBlue = data[offset + 2];
        const originalLuminance = originalRed * 0.299 + originalGreen * 0.587 + originalBlue * 0.114;
        let red = originalRed;
        let green = originalGreen;
        let blue = originalBlue;

        if (preparedFaces.length) {
          let faceWeight = 0;
          let adaptiveLift = 0;
          for (const face of preparedFaces) {
            const weight = faceSkinMask(x, y, face);
            if (weight > faceWeight) {
              faceWeight = weight;
              adaptiveLift = face.lift;
            }
          }
          if (faceWeight > 0) {
            const cb = 128 - originalRed * 0.168736 - originalGreen * 0.331264 + originalBlue * 0.5;
            const cr = 128 + originalRed * 0.5 - originalGreen * 0.418688 - originalBlue * 0.081312;
            const skinColor = smoothStep(72, 90, cb) * (1 - smoothStep(125, 142, cb))
              * smoothStep(124, 138, cr) * (1 - smoothStep(177, 192, cr));
            const toneProtection = smoothStep(22, 58, originalLuminance) * (1 - smoothStep(230, 252, originalLuminance));
            const skinWeight = faceWeight * skinColor * toneProtection;
            if (skinWeight > 0) {
              const smoothing = skinWeight * (0.20 + beautyStrength * 0.32);
              red += (smooth[offset] - red) * smoothing + adaptiveLift * skinWeight;
              green += (smooth[offset + 1] - green) * smoothing + adaptiveLift * skinWeight * 0.86;
              blue += (smooth[offset + 2] - blue) * smoothing + adaptiveLift * skinWeight * 0.74;
              const smoothedLuminance = red * 0.299 + green * 0.587 + blue * 0.114;
              const chromaRetention = 1 - skinWeight * beautyStrength * 0.045;
              red = smoothedLuminance + (red - smoothedLuminance) * chromaRetention;
              green = smoothedLuminance + (green - smoothedLuminance) * chromaRetention;
              blue = smoothedLuminance + (blue - smoothedLuminance) * chromaRetention;
            }
          }
        }

        if (clarityStrength > 0 || manualSharpness > 0) {
          const blurredLuminance = smooth[offset] * 0.299 + smooth[offset + 1] * 0.587 + smooth[offset + 2] * 0.114;
          const left = offset - 4;
          const right = offset + 4;
          const up = offset - widthStride;
          const down = offset + widthStride;
          const horizontalEdge = Math.abs(
            (smooth[left] * 0.299 + smooth[left + 1] * 0.587 + smooth[left + 2] * 0.114)
            - (smooth[right] * 0.299 + smooth[right + 1] * 0.587 + smooth[right + 2] * 0.114)
          );
          const verticalEdge = Math.abs(
            (smooth[up] * 0.299 + smooth[up + 1] * 0.587 + smooth[up + 2] * 0.114)
            - (smooth[down] * 0.299 + smooth[down + 1] * 0.587 + smooth[down + 2] * 0.114)
          );
          const edgeMask = smoothStep(3.5, 19, horizontalEdge + verticalEdge);
          const midtoneMask = 1 - smoothStep(88, 132, Math.abs(originalLuminance - 128));
          const highPass = clamp(originalLuminance - blurredLuminance, -14, 14);
          const detailGain = manualSharpness * (0.18 + edgeMask * 0.88)
            + clarityStrength * (0.16 + edgeMask * 0.72);
          const detail = highPass * detailGain * (0.42 + midtoneMask * 0.58);
          red += detail;
          green += detail;
          blue += detail;
        }

        data[offset] = clamp(red, 0, 255);
        data[offset + 1] = clamp(green, 0, 255);
        data[offset + 2] = clamp(blue, 0, 255);
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function addWatermark(canvas) {
  const text = $('#watermarkText').value.trim();
  if (!text) return canvas;
  const context = canvas.getContext('2d');
  const scale = Number($('#watermarkSize').value);
  const fontSize = Math.max(13, Math.round(Math.min(canvas.width, canvas.height) * (0.012 + scale * 0.007)));
  const padding = Math.max(12, Math.round(fontSize * 0.75));
  context.save();
  context.globalAlpha = Number($('#watermarkOpacity').value) / 100;
  context.fillStyle = $('#watermarkColor').value;
  context.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0,0,0,.22)';
  context.shadowBlur = Math.max(2, fontSize * 0.12);
  const metrics = context.measureText(text);
  const position = $('#watermarkPosition').value;
  let x = canvas.width - padding - metrics.width;
  let y = canvas.height - padding - fontSize / 2;
  if (position.includes('left')) x = padding;
  if (position.includes('top')) y = padding + fontSize / 2;
  if (position === 'center') { x = (canvas.width - metrics.width) / 2; y = canvas.height / 2; }
  context.fillText(text, x, y);
  context.restore();
  return canvas;
}

function addMosaic(canvas) {
  if (!$('#mosaicEnabled').checked) return canvas;
  const regionWidth = Math.max(1, Math.round(canvas.width * Number($('#mosaicWidth').value) / 100));
  const regionHeight = Math.max(1, Math.round(canvas.height * Number($('#mosaicHeight').value) / 100));
  const left = Math.round((canvas.width - regionWidth) * Number($('#mosaicX').value) / 100);
  const top = Math.round((canvas.height - regionHeight) * Number($('#mosaicY').value) / 100);
  const strength = Number($('#mosaicStrength').value);
  const smallWidth = Math.max(1, Math.round(regionWidth / strength));
  const smallHeight = Math.max(1, Math.round(regionHeight / strength));
  const sample = canvas2d(smallWidth, smallHeight);
  const sampleContext = sample.getContext('2d');
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.drawImage(canvas, left, top, regionWidth, regionHeight, 0, 0, smallWidth, smallHeight);
  const context = canvas.getContext('2d');
  context.save();
  context.imageSmoothingEnabled = false;
  context.drawImage(sample, 0, 0, smallWidth, smallHeight, left, top, regionWidth, regionHeight);
  context.restore();
  return canvas;
}

function paintQuickPreview(canvas, original = false) {
  if (!canvas) return;
  previewCanvas.width = canvas.width;
  previewCanvas.height = canvas.height;
  previewCanvas.getContext('2d').drawImage(canvas, 0, 0);
  $('#holdOriginal').classList.toggle('active', original);
  $('#holdOriginal').textContent = original ? '松开看效果' : '按住看原图';
  $('#holdOriginal').setAttribute('aria-pressed', String(original));
}

function showQuickPreviewOriginal(show) {
  paintQuickPreview(show ? quickPreviewOriginalCanvas : quickPreviewResultCanvas, show);
}

$('#holdOriginal').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  showQuickPreviewOriginal(true);
});
window.addEventListener('pointerup', () => showQuickPreviewOriginal(false));
window.addEventListener('pointercancel', () => showQuickPreviewOriginal(false));
$('#holdOriginal').addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    showQuickPreviewOriginal(true);
  }
});
$('#holdOriginal').addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') showQuickPreviewOriginal(false);
});

async function renderQuickPreview() {
  const token = ++quickPreviewToken;
  const figure = $('#quickPreview');
  if (!photos.length || $('#personEnabled').checked) {
    figure.hidden = true;
    return;
  }
  try {
    const image = await photos[0].imagePromise;
    if (token !== quickPreviewToken) return;
    const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight));
    const base = canvas2d(
      Math.max(1, Math.round(image.naturalWidth * scale)),
      Math.max(1, Math.round(image.naturalHeight * scale))
    );
    base.getContext('2d').drawImage(image, 0, 0, base.width, base.height);
    applyRemovalEdits(base, photos[0]);
    applyTextEdits(base, photos[0]);
    let result = transformedCanvas(base);
    const originalResult = canvas2d(result.width, result.height);
    originalResult.getContext('2d').drawImage(result, 0, 0);
    result = await adjustedCanvas(result);
    if (token !== quickPreviewToken) return;
    result = addMosaic(result);
    result = addWatermark(result);
    quickPreviewOriginalCanvas = originalResult;
    quickPreviewResultCanvas = result;
    paintQuickPreview(result);
    figure.hidden = false;
    $('#holdOriginal').hidden = !hasImageEdits();
    if (pendingEffectReveal) {
      figure.classList.remove('effect-reveal');
      requestAnimationFrame(() => figure.classList.add('effect-reveal'));
      pendingEffectReveal = '';
      setTimeout(() => figure.classList.remove('effect-reveal'), 1300);
    }
  } catch (error) {
    console.error(error);
    figure.hidden = true;
  }
}

function scheduleQuickPreview() {
  clearTimeout(quickPreviewTimer);
  quickPreviewTimer = setTimeout(renderQuickPreview, 90);
}

async function encodedCanvas(canvas, ext) {
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const quality = Number($('#outputQuality').value) / 100;
  let blob = await canvasToBlob(canvas, mime, quality);
  const target = Number($('#targetKB').value) * 1024;
  if (!target || ext === 'png' || blob.size <= target) return blob;
  let low = 0.08;
  let high = quality;
  let best = null;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const current = (low + high) / 2;
    const candidate = await canvasToBlob(canvas, mime, current);
    if (candidate.size <= target) { best = candidate; low = current; }
    else high = current;
  }
  return best || canvasToBlob(canvas, mime, 0.08);
}

async function processPhoto(photo) {
  if (!hasImageEdits()) return { blob: photo.file, ext: photo.ext };
  const image = await photo.imagePromise;
  const composingPerson = $('#personEnabled').checked;
  const dimensions = composingPerson
    ? outputDimensions(image)
    : { width: image.naturalWidth, height: image.naturalHeight };
  const base = canvas2d(dimensions.width, dimensions.height);
  if (composingPerson) {
    const supersample = clamp(Math.ceil(900 / Math.max(dimensions.width, dimensions.height)), 1, 4);
    if (supersample > 1) {
      const highResolution = canvas2d(
        dimensions.width * supersample,
        dimensions.height * supersample
      );
      await drawPersonComposition(photo, highResolution, dimensions, false);
      const baseContext = base.getContext('2d');
      baseContext.imageSmoothingEnabled = true;
      baseContext.imageSmoothingQuality = 'high';
      baseContext.drawImage(highResolution, 0, 0, base.width, base.height);
    } else {
      await drawPersonComposition(photo, base, dimensions, false);
    }
  } else {
    base.getContext('2d').drawImage(image, 0, 0, base.width, base.height);
  }
  applyRemovalEdits(base, photo);
  applyTextEdits(base, photo);
  let canvas = transformedCanvas(base);
  if (!composingPerson) canvas = resizedCanvas(canvas);
  canvas = await adjustedCanvas(canvas);
  canvas = addMosaic(canvas);
  canvas = addWatermark(canvas);
  const ext = outputExtension(photo);
  return { blob: await encodedCanvas(canvas, ext), ext };
}

function saveBlob(blob, name) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function shareableFiles(entries) {
  return entries.map((entry) => new File(
    [entry.blob],
    entry.name,
    { type: entry.blob.type || 'application/octet-stream' }
  ));
}

function canShareFiles(files) {
  if (!navigator.share || !navigator.canShare || !files.length) return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

function releaseSaveTray() {
  saveTrayUrls.forEach((url) => URL.revokeObjectURL(url));
  saveTrayUrls = [];
  saveTrayEntries = [];
  saveTrayZip = null;
  saveTrayTemporaryUrl = '';
  $('#saveTrayList').innerHTML = '';
  $('#saveTray').hidden = true;
  $('#zipFallback').hidden = true;
  $('#zipFallbackLink').removeAttribute('href');
  $('#zipFallbackLink').hidden = false;
  $('#sharePackageFile').hidden = true;
  delete $('#retryNormalDownload').dataset.temporaryUpload;
}

function showSaveTray(entries, zipEntry = null) {
  releaseSaveTray();
  saveTrayEntries = entries;
  saveTrayZip = zipEntry;
  const files = shareableFiles(entries);

  $('#saveTrayList').innerHTML = entries.map((entry, index) => {
    const url = URL.createObjectURL(entry.blob);
    saveTrayUrls.push(url);
    return `<article class="save-result">
      <img src="${url}" alt="${esc(entry.name)}" draggable="false">
      <div>
        <b>${esc(entry.name)}</b>
        <small>长按上方图片保存到相册</small>
        <button type="button" data-share-result="${index}">分享 / 保存这张</button>
        <a href="${url}" download="${esc(entry.name)}">普通下载</a>
      </div>
    </article>`;
  }).join('');

  const shareAll = $('#shareAllResults');
  shareAll.hidden = !canShareFiles(files);
  shareAll.textContent = entries.length > 1 ? `分享 / 保存全部 ${entries.length} 张` : '用手机分享 / 保存';

  if (zipEntry) {
    const isWordDocument = /\.docx$/i.test(zipEntry.name);
    const fileKind = isWordDocument ? 'Word 文档' : 'ZIP';
    const packageFiles = shareableFiles([zipEntry]);
    const zipUrl = URL.createObjectURL(zipEntry.blob);
    saveTrayUrls.push(zipUrl);
    $('#zipFallbackName').textContent = zipEntry.name;
    $('#packageFallbackHelp').textContent = isWordDocument
      ? (isWechat
        ? '点击下方按钮会把这个 Word 临时上传到你的服务器，生成正常 HTTPS 链接，10分钟后自动删除。'
        : '可以直接保存 Word；如果系统支持，也可以交给 WPS 或文件管理器。')
      : '微信可能会拦截 ZIP；可以先尝试下载，失败时请逐张保存图片。';
    $('#zipFallbackLink').href = zipUrl;
    $('#zipFallbackLink').download = zipEntry.name;
    $('#zipFallbackLink').textContent = `尝试下载 ${fileKind}`;
    $('#zipFallbackLink').hidden = isWordDocument && isWechat;
    $('#sharePackageFile').hidden = !canShareFiles(packageFiles);
    $('#sharePackageFile').textContent = isWordDocument ? '保存 / 分享 Word' : '分享 ZIP 文件';
    $('#retryNormalDownload').textContent = isWordDocument && isWechat
      ? '生成10分钟下载链接'
      : `普通下载 ${isWordDocument ? 'Word' : 'ZIP'}`;
    if (isWordDocument && isWechat) $('#retryNormalDownload').dataset.temporaryUpload = '1';
    $('#zipFallback').hidden = false;
    $('#saveTrayHint').textContent = isWordDocument
      ? (isWechat
        ? 'Word 已经在本地生成；你可以优先使用系统分享，或主动生成10分钟临时下载链接。'
        : 'Word 文档已经生成，可以保存或分享。')
      : 'ZIP 在微信里可能被拦截；可以尝试下载，也可以直接长按下方图片逐张保存。';
  } else {
    $('#sharePackageFile').hidden = true;
    $('#retryNormalDownload').textContent = '尝试普通下载';
    $('#saveTrayHint').textContent = '长按下方图片，选择“保存图片”即可存入相册。';
  }

  $('#saveTray').hidden = false;
  $('#saveTray').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function shareEntries(entries) {
  const files = shareableFiles(entries);
  if (!canShareFiles(files)) return false;
  await navigator.share({ files, title: '片刻生成的图片' });
  return true;
}

$('#closeSaveTray').addEventListener('click', releaseSaveTray);

$('#saveTrayList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-share-result]');
  if (!button) return;
  const entry = saveTrayEntries[Number(button.dataset.shareResult)];
  if (!entry) return;
  try {
    if (!await shareEntries([entry])) {
      saveBlob(entry.blob, entry.name);
      flash('当前环境不支持文件分享，已尝试普通下载');
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      saveBlob(entry.blob, entry.name);
      flash('分享没有打开，已尝试普通下载');
    }
  }
});

$('#shareAllResults').addEventListener('click', async () => {
  try {
    await shareEntries(saveTrayEntries);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      flash('系统未能分享全部图片，请逐张保存');
    }
  }
});

$('#sharePackageFile').addEventListener('click', async () => {
  if (!saveTrayZip) return;
  const files = shareableFiles([saveTrayZip]);
  try {
    if (!canShareFiles(files)) {
      saveBlob(saveTrayZip.blob, saveTrayZip.name);
      flash('系统不支持文件分享，已尝试普通下载');
      return;
    }
    await navigator.share({ files, title: saveTrayZip.name });
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      saveBlob(saveTrayZip.blob, saveTrayZip.name);
      flash('分享没有打开，已尝试普通下载');
    }
  }
});

async function createTemporaryDownload(entry) {
  const response = await fetch('/api/downloads', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': entry.blob.type,
      'X-File-Name': encodeURIComponent(entry.name)
    },
    body: entry.blob
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // The status-specific message below is clearer than a JSON parsing error.
  }
  if (response.status === 401) throw new Error('登录已经过期，请重新进入网站后再生成下载链接');
  if (!response.ok || !result.url) throw new Error(result.error || '临时下载链接生成失败');
  return new URL(result.url, window.location.origin).href;
}

$('#retryNormalDownload').addEventListener('click', async () => {
  if (saveTrayZip) {
    if ($('#retryNormalDownload').dataset.temporaryUpload === '1') {
      const button = $('#retryNormalDownload');
      if (saveTrayTemporaryUrl) {
        window.location.assign(saveTrayTemporaryUrl);
        return;
      }
      button.disabled = true;
      button.textContent = '正在生成安全下载链接…';
      try {
        saveTrayTemporaryUrl = await createTemporaryDownload(saveTrayZip);
        $('#zipFallbackLink').href = saveTrayTemporaryUrl;
        $('#zipFallbackLink').removeAttribute('download');
        $('#zipFallbackLink').textContent = '打开正常下载链接';
        $('#zipFallbackLink').hidden = false;
        button.textContent = '再次打开下载链接';
        flash('下载链接已生成，正在打开；10分钟后自动失效');
        window.location.assign(saveTrayTemporaryUrl);
      } catch (error) {
        console.error(error);
        button.textContent = '重新生成10分钟下载链接';
        flash(error.message || '临时下载链接生成失败');
      } finally {
        button.disabled = false;
      }
      return;
    }
    saveBlob(saveTrayZip.blob, saveTrayZip.name);
    flash(`已尝试下载 ${/\.docx$/i.test(saveTrayZip.name) ? 'Word 文档' : 'ZIP'}`);
    return;
  }
  saveTrayEntries.forEach((entry, index) => setTimeout(() => saveBlob(entry.blob, entry.name), index * 280));
  flash(saveTrayEntries.length > 1 ? '已尝试逐张下载' : '已尝试下载图片');
});

if (isWechat) {
  $('#wechatOpenTip').hidden = false;
  $('#mobileNote').textContent = '图片仍可长按保存；Word 可按需生成10分钟临时下载链接，转到浏览器后也能正常打开。';
  $('#downloadFiles').querySelector('small').textContent = '生成后长按保存，或使用手机分享';
  $('#downloadZip').querySelector('small').textContent = '微信可能拦截，仍可生成后尝试';
  $('#downloadWord').querySelector('small').textContent = '生成后可保存、分享或交给 WPS';
}

window.addEventListener('beforeunload', () => {
  saveTrayUrls.forEach((url) => URL.revokeObjectURL(url));
});

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const u16 = (value) => new Uint8Array([value & 255, (value >>> 8) & 255]);
const u32 = (value) => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);

function join(chunks) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  chunks.forEach((chunk) => { output.set(chunk, position); position += chunk.length; });
  return output;
}

async function makeZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const checksum = crc32(data);
    const local = join([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    localParts.push(local);
    centralParts.push(join([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = join([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralSize), u32(offset), u16(0)]);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function xmlText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

async function prepareWordImage(entry, index) {
  const sourceUrl = URL.createObjectURL(entry.blob);
  try {
    const image = await imageFromUrl(sourceUrl);
    const sourceIsJpeg = /^image\/jpe?g$/i.test(entry.blob.type) || /\.jpe?g$/i.test(entry.name);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (sourceIsJpeg && sourceWidth <= 1400 && sourceHeight <= 2000 && entry.blob.size <= 800000) {
      return {
        blob: entry.blob,
        ext: 'jpeg',
        width: sourceWidth,
        height: sourceHeight,
        index
      };
    }
    const scale = Math.min(1, 1400 / sourceWidth, 2000 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const optimized = await canvasToBlob(canvas, 'image/jpeg', 0.84);
    if (sourceIsJpeg && scale === 1 && entry.blob.size <= optimized.size) {
      return {
        blob: entry.blob,
        ext: 'jpeg',
        width: sourceWidth,
        height: sourceHeight,
        index
      };
    }
    return {
      blob: optimized,
      ext: 'jpeg',
      width,
      height,
      index
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function makeWordDocument(entries) {
  const images = [];
  for (let start = 0; start < entries.length; start += 2) {
    const batch = entries.slice(start, start + 2);
    images.push(...await Promise.all(
      batch.map((entry, offset) => prepareWordImage(entry, start + offset))
    ));
  }

  const maxWidthEmu = 5700000;
  const maxHeightEmu = 8300000;
  const paragraphs = images.map((image, index) => {
    const ratio = Math.min(maxWidthEmu / image.width, maxHeightEmu / image.height);
    const widthEmu = Math.max(1, Math.round(image.width * ratio));
    const heightEmu = Math.max(1, Math.round(image.height * ratio));
    const name = xmlText(entries[index].name);
    const pageBreak = index < images.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '';
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="180"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${name}</w:t></w:r></w:p>
      <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="${index + 1}" name="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
      <pic:nvPicPr><pic:cNvPr id="${index + 1}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
      </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${pageBreak}`;
  }).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
    </w:document>`;

  const relationships = images.map((image, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.ext}"/>`
  ).join('');
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="jpeg" ContentType="image/jpeg"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`;

  const packageEntries = [
    { name: '[Content_Types].xml', blob: new Blob([contentTypes], { type: 'application/xml' }) },
    { name: '_rels/.rels', blob: new Blob([rootRels], { type: 'application/xml' }) },
    { name: 'word/document.xml', blob: new Blob([documentXml], { type: 'application/xml' }) },
    { name: 'word/_rels/document.xml.rels', blob: new Blob([documentRels], { type: 'application/xml' }) },
    ...images.map((image, index) => ({ name: `word/media/image${index + 1}.${image.ext}`, blob: image.blob }))
  ];
  const zip = await makeZip(packageEntries);
  return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function defaultWordDocumentStem() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `图片文档_${date}`;
}

function wordDocumentName() {
  const requested = $('#wordFileName').value.trim().replace(/\.docx$/i, '');
  return `${cleanName(requested || defaultWordDocumentStem())}.docx`;
}

$('#wordFileName').value = defaultWordDocumentStem();

async function pickWordSaveHandle(name) {
  if (isWechat || isMobileBrowser || typeof window.showSaveFilePicker !== 'function') return null;
  return window.showSaveFilePicker({
    suggestedName: name,
    types: [{
      description: 'Word 文档',
      accept: {
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
      }
    }]
  });
}

async function writeFileHandle(handle, blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

async function prepareEntries() {
  const names = resolvedNames();
  const entries = [];
  for (let index = 0; index < photos.length; index += 1) {
    $('#personStatus').textContent = $('#personEnabled').checked ? `正在处理第 ${index + 1}/${photos.length} 张人物照片…` : $('#personStatus').textContent;
    const processed = await processPhoto(photos[index]);
    const base = names[index].replace(/\.[^.]+$/, '');
    entries.push({ name: `${base}.${processed.ext}`, blob: processed.blob });
  }
  return entries;
}

function setBusy(busy, label = '') {
  ['#downloadZip', '#downloadFiles', '#downloadWord'].forEach((selector) => { $(selector).disabled = busy || !photos.length; });
  if (label) flash(label);
}

async function downloadOne(index) {
  try {
    setBusy(true, '正在生成图片…');
    const processed = await processPhoto(photos[index]);
    const base = resolvedNames()[index].replace(/\.[^.]+$/, '');
    const entry = { blob: processed.blob, name: `${base}.${processed.ext}` };
    if (isWechat) {
      showSaveTray([entry]);
      flash('图片已生成，请长按保存');
    } else if (isMobileBrowser && canShareFiles(shareableFiles([entry]))) {
      showSaveTray([entry]);
      flash('图片已生成，可分享或保存');
    } else {
      saveBlob(entry.blob, entry.name);
      flash('图片已生成');
    }
    markDeskReady();
  } catch (error) {
    console.error(error);
    flash(error.message || '图片生成失败');
  } finally {
    setBusy(false);
  }
}

$('#downloadZip').addEventListener('click', async () => {
  if (!photos.length) return;
  try {
    setBusy(true, '正在处理并打包…');
    const entries = await prepareEntries();
    const zip = await makeZip(entries);
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const zipEntry = { blob: zip, name: `改名图片_${date}.zip` };
    if (isWechat) {
      showSaveTray(entries, zipEntry);
      flash('ZIP 已生成；微信拦截时可逐张保存');
    } else {
      saveBlob(zipEntry.blob, zipEntry.name);
      flash('ZIP 压缩包已生成');
    }
    markDeskReady();
  } catch (error) {
    console.error(error);
    flash(error.message || '打包失败，请稍后重试');
  } finally {
    setBusy(false);
  }
});

$('#downloadWord').addEventListener('click', async () => {
  if (!photos.length) return;
  const wordName = wordDocumentName();
  try {
    const saveHandle = await pickWordSaveHandle(wordName);
    setBusy(true, '正在生成 Word 文档…');
    const entries = await prepareEntries();
    const documentBlob = await makeWordDocument(entries);
    const wordEntry = { blob: documentBlob, name: wordName };
    if (saveHandle) {
      await writeFileHandle(saveHandle, documentBlob);
      flash(`Word 文档已保存：${wordName}`);
    } else if (isWechat || isMobileBrowser) {
      showSaveTray(entries, wordEntry);
      flash(canShareFiles(shareableFiles([wordEntry]))
        ? 'Word 已生成，请点“保存 / 分享 Word”'
        : 'Word 已生成，可尝试普通下载');
    } else {
      saveBlob(wordEntry.blob, wordEntry.name);
      flash(`Word 文档已生成：${wordName}`);
    }
    markDeskReady();
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(error);
    flash(error.message || 'Word 文档生成失败');
  } finally {
    setBusy(false);
  }
});

$('#downloadFiles').addEventListener('click', async () => {
  if (!photos.length) return;
  try {
    setBusy(true, '正在生成普通图片…');
    const entries = await prepareEntries();
    const files = shareableFiles(entries);
    if (isWechat || (isMobileBrowser && canShareFiles(files))) {
      showSaveTray(entries);
      flash(isWechat ? '图片已生成，请长按保存' : '图片已生成，可分享或保存');
    } else {
      entries.forEach((entry, index) => setTimeout(() => saveBlob(entry.blob, entry.name), index * 280));
      flash(entries.length > 1 ? '正在逐张下载；浏览器可能询问是否允许多个下载' : '图片已下载');
    }
    markDeskReady();
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      flash(error.message || '图片生成失败');
    }
  } finally {
    setBusy(false);
  }
});

$('.edit-area').addEventListener('input', (event) => {
  if (event.target.matches('input[type="range"]')) syncControlLabels();
  if (['brightness', 'contrast', 'saturation', 'vibrance', 'warmth', 'tint', 'highlights', 'shadows', 'fade', 'vignette', 'sharpen'].includes(event.target.id)) {
    document.querySelectorAll('[data-color-preset]').forEach((button) => button.classList.remove('active'));
    $('#presetStatus').textContent = '正在使用手动调色';
  }
  if (event.target.id === 'outputFormat' || event.target.id === 'targetKB' || event.target.id === 'watermarkText') refreshResolvedNames();
  if (!event.target.closest('.portrait-panel')) scheduleQuickPreview();
});

$('.edit-area').addEventListener('change', () => {
  syncControlLabels();
  refreshResolvedNames();
  checkpointHistory();
  scheduleQuickPreview();
});

$('#resetAll').addEventListener('click', () => {
  if (!defaultSnapshot) return;
  restoreSnapshot(defaultSnapshot);
  backgroundImage = null;
  customBackgroundActive = false;
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  backgroundUrl = '';
  $('#clearBackground').hidden = true;
  document.querySelectorAll('[data-color-preset]').forEach((button) => button.classList.remove('active'));
  $('#presetStatus').textContent = '尚未选择风格';
  checkpointHistory();
  flash('已恢复原始设置');
});

window.addEventListener('beforeunload', () => {
  photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
  if (ocrWorkerPromise) ocrWorkerPromise.then((worker) => worker.terminate()).catch(() => {});
});

if (deskPreset) {
  $('#jobHandoff').hidden = false;
  $('#jobHandoffTitle').textContent = `已接收订单 ${deskPreset.job}`;
  const parts = [
    deskPreset.standard ? `模板 ${deskPreset.standard}` : '',
    deskPreset.width && deskPreset.height ? `${deskPreset.width}×${deskPreset.height}px` : '',
    deskPreset.maximumKb ? `≤${deskPreset.maximumKb}KB` : '',
    deskPreset.format ? deskPreset.format.toUpperCase() : '',
    deskPreset.background ? `底色 ${deskPreset.background}` : ''
  ].filter(Boolean);
  $('#jobHandoffDetail').textContent = parts.length
    ? `选择顾客原图后自动套用：${parts.join(' · ')}`
    : '选择顾客原图后开始处理；文件名仍可在图片下方修改。';
  $('#returnAssistant').href = `/assistant/?job=${encodeURIComponent(deskPreset.job)}&done=1`;
}

syncControlLabels();
syncEffectReceipt();
defaultSnapshot = settingsSnapshot();
history = [defaultSnapshot];
historyIndex = 0;
updateHistoryButtons();
renderPhotos();
syncTextPresetButtons();
syncInkControlLabels();
