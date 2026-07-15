const $ = (selector) => document.querySelector(selector);
const personNumber = $('#personNumber');
const personName = $('#personName');
const photoPicker = $('#photoPicker');
const dropZone = $('#dropZone');
const photoGrid = $('#photoGrid');
const toast = $('#toast');

const CODE_PREFIX = '2025213300';
const MAX_NUMBER = 41;
const MAX_PHOTOS = 2;
const imageExtensions = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
let photos = [];
let toastTimer;

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
    .slice(0, 60);
}

function padNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_NUMBER
    ? String(number).padStart(2, '0')
    : '';
}

function identity() {
  return { number: padNumber(personNumber.value), name: cleanName(personName.value) };
}

function personCode() {
  const { number } = identity();
  return number ? `${CODE_PREFIX}${number}` : `${CODE_PREFIX}__`;
}

function photoBase(index) {
  const info = identity();
  return `${personCode()}_${info.name || '待填写姓名'}_${String(index + 1).padStart(2, '0')}`;
}

function fileExtension(file) {
  const dot = file.name.lastIndexOf('.');
  return (dot >= 0 ? file.name.slice(dot + 1) : 'img')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'img';
}

function isImage(file) {
  return file.type.startsWith('image/') || imageExtensions.test(file.name);
}

function flash(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2700);
}

function validateIdentity(show = true) {
  const info = identity();
  let error = '';
  if (!info.number) error = '请输入01—41之间的个人序号';
  else if (!info.name) error = '请输入姓名';
  if (show || !error) $('#identityError').textContent = error;
  return !error;
}

function renderPhotos() {
  const hasPhotos = photos.length > 0;
  $('#photoToolbar').classList.toggle('show', hasPhotos);
  $('#photoCount').textContent = `已选择 ${photos.length}/${MAX_PHOTOS} 张`;
  $('#photoHint').textContent = photos.length === 1 ? '已可生成，还可以再选1张' : photos.length === 2 ? '两张照片已齐' : '';
  $('#downloadPersonal').disabled = !hasPhotos;
  photoGrid.innerHTML = photos.map((photo, index) => {
    const newName = `${photoBase(index)}.${photo.ext}`;
    return `<article class="photo-card" data-index="${index}">
      <img src="${photo.url}" alt="第${index + 1}张照片预览">
      <div class="photo-meta"><span title="${esc(photo.file.name)}">原图：${esc(photo.file.name)}</span><b title="${esc(newName)}">${esc(newName)}</b></div>
      <button class="remove-photo" data-remove aria-label="移除第${index + 1}张照片">×</button>
    </article>`;
  }).join('');
}

function addPhotos(fileList) {
  const valid = [...fileList].filter(isImage);
  const remaining = Math.max(0, MAX_PHOTOS - photos.length);
  const accepted = valid.slice(0, remaining);
  accepted.forEach((file) => photos.push({ file, ext: fileExtension(file), url: URL.createObjectURL(file) }));
  renderPhotos();
  if (valid.length > remaining) flash('每个人最多两张，已忽略多余照片');
  else if (accepted.length) flash(`已添加 ${accepted.length} 张照片`);
  else flash('请选择图片文件');
}

photoPicker.addEventListener('change', () => {
  addPhotos(photoPicker.files);
  photoPicker.value = '';
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

[personNumber, personName].forEach((input) => input.addEventListener('input', () => {
  if (input === personName) personName.value = personName.value.slice(0, 30);
  validateIdentity(false);
  renderPhotos();
}));

photoGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  const card = button.closest('.photo-card');
  const index = Number(card.dataset.index);
  const [photo] = photos.splice(index, 1);
  if (photo) URL.revokeObjectURL(photo.url);
  renderPhotos();
});

$('#clearPhotos').addEventListener('click', () => {
  photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  photos = [];
  renderPhotos();
  flash('照片已清空');
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

function u16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

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
    const data = new Uint8Array(await entry.data.arrayBuffer());
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

function saveBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  const url = link.href;
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('#downloadPersonal').addEventListener('click', async () => {
  if (!validateIdentity(true)) {
    if (!padNumber(personNumber.value)) personNumber.focus();
    else personName.focus();
    return;
  }
  if (!photos.length) {
    flash('请先选择一张或两张照片');
    return;
  }
  const button = $('#downloadPersonal');
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    const entries = photos.map((photo, index) => ({ name: `${photoBase(index)}.${photo.ext}`, data: photo.file }));
    const blob = await makeZip(entries);
    const info = identity();
    saveBlob(blob, `${CODE_PREFIX}${info.number}_${info.name}_照片包.zip`);
    flash('个人照片包已生成');
  } catch (error) {
    console.error(error);
    flash('生成失败，请稍后重试');
  } finally {
    button.disabled = false;
    button.textContent = '生成并下载';
  }
});

window.addEventListener('beforeunload', () => photos.forEach((photo) => URL.revokeObjectURL(photo.url)));
renderPhotos();
