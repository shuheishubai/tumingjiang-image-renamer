const $ = (selector) => document.querySelector(selector);
const grid = $('#peopleGrid');
const rosterInput = $('#rosterInput');
const rosterError = $('#rosterError');
const toast = $('#toast');

const CODE_PREFIX = '2025213300';
const MAX_NUMBER = 41;
const MAX_PHOTOS = 2;
const imageExtensions = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
let people = [];
let toastTimer;

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

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

function personCode(person) {
  const number = padNumber(person.number);
  return number ? `${CODE_PREFIX}${number}` : '';
}

function photoBase(person, photoIndex) {
  const code = personCode(person) || `${CODE_PREFIX}__`;
  const name = cleanName(person.name) || '待填写姓名';
  return `${code}_${name}_${String(photoIndex + 1).padStart(2, '0')}`;
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
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function duplicateNumbers() {
  const counts = new Map();
  people.forEach((person) => {
    const number = padNumber(person.number);
    if (number) counts.set(number, (counts.get(number) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count > 1).map(([number]) => number));
}

function personIssue(person, duplicates) {
  const number = padNumber(person.number);
  if (!number) return '请填写01—41之间的序号';
  if (duplicates.has(number)) return `序号${number}重复`;
  if (!cleanName(person.name)) return '请填写姓名';
  if (!person.photos.length) return '请添加一张或两张照片';
  return '';
}

function allIssues() {
  const duplicates = duplicateNumbers();
  return people.map((person, index) => {
    const issue = personIssue(person, duplicates);
    return issue ? `第${index + 1}人：${issue}` : '';
  }).filter(Boolean);
}

function releasePerson(person) {
  person.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
}

function render() {
  const duplicates = duplicateNumbers();
  const photoTotal = people.reduce((total, person) => total + person.photos.length, 0);
  const ready = people.filter((person) => !personIssue(person, duplicates)).length;

  $('#emptyState').style.display = people.length ? 'none' : 'flex';
  grid.innerHTML = people.map((person, personIndex) => {
    const issue = personIssue(person, duplicates);
    const previews = person.photos.map((photo, photoIndex) => {
      const newName = `${photoBase(person, photoIndex)}.${photo.ext}`;
      return `<div class="photo-item">
        <img src="${photo.url}" alt="${esc(person.name || `第${personIndex + 1}人`)}的第${photoIndex + 1}张照片">
        <div class="photo-name"><b title="${esc(newName)}">${esc(newName)}</b><span title="${esc(photo.file.name)}">原图：${esc(photo.file.name)}</span></div>
        <button class="remove-photo" data-remove-photo="${photoIndex}" aria-label="移除这张照片">×</button>
      </div>`;
    }).join('');

    return `<article class="person-card ${issue ? 'invalid' : ''}" data-id="${person.id}">
      <div class="person-row">
        <div class="person-index">${String(personIndex + 1).padStart(2, '0')}</div>
        <label class="field"><span>人员序号</span><input data-field="number" type="number" min="1" max="41" value="${esc(person.number)}" placeholder="01"></label>
        <label class="field"><span>姓名</span><input data-field="name" maxlength="30" value="${esc(person.name)}" placeholder="请输入姓名"></label>
        <button class="remove-person" data-remove-person>删除此人</button>
      </div>
      <div class="photo-area">
        <label class="photo-picker"><input data-photos type="file" accept="image/*" multiple><span>${person.photos.length ? `继续添加（${person.photos.length}/2）` : '选择1张或2张照片'}</span></label>
        <div class="photo-list">${previews || '<div class="person-status">尚未选择照片</div>'}</div>
      </div>
      <div class="person-status ${issue ? 'bad' : ''}">${issue || `已完成 · ${person.photos.length}张照片`}</div>
    </article>`;
  }).join('');

  $('#personCount').textContent = people.length;
  $('#photoCount').textContent = photoTotal;
  $('#readyCount').textContent = ready;
  $('#downloadFinal').disabled = people.length === 0;
  const issues = allIssues();
  $('#exportHint').textContent = !people.length
    ? '添加名单和照片后，可以直接下载总压缩包。'
    : issues.length
      ? `还有 ${issues.length} 人需要补充信息或照片。`
      : `${people.length} 人已经整理完成，可以导出最终版。`;
}

function parseRoster(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\d{1,2})(?:\s+|[,，、:：-]\s*)(.+)$/);
    if (!match || !padNumber(match[1]) || !cleanName(match[2])) {
      errors.push(`第${index + 1}行格式不正确：${line}`);
      return;
    }
    parsed.push({ id: uid(), number: padNumber(match[1]), name: cleanName(match[2]), photos: [] });
  });
  return { parsed, errors };
}

$('#createRoster').addEventListener('click', () => {
  const { parsed, errors } = parseRoster(rosterInput.value);
  if (!parsed.length) {
    rosterError.textContent = errors[0] || '请先粘贴名单';
    return;
  }
  if (errors.length) {
    rosterError.textContent = errors.slice(0, 2).join('；');
    return;
  }
  if (people.some((person) => person.photos.length) && !confirm('重新生成名单会清空已选择的照片，是否继续？')) return;
  people.forEach(releasePerson);
  people = parsed;
  rosterError.textContent = '';
  render();
  flash(`已生成 ${people.length} 人的照片清单`);
});

$('#addPerson').addEventListener('click', () => {
  people.push({ id: uid(), number: '', name: '', photos: [] });
  render();
  grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('#clearAll').addEventListener('click', () => {
  if (!people.length) return;
  if (!confirm('确定清空全部名单和已选择的照片吗？')) return;
  people.forEach(releasePerson);
  people = [];
  rosterInput.value = '';
  rosterError.textContent = '';
  render();
  flash('已清空全部内容');
});

grid.addEventListener('change', (event) => {
  const card = event.target.closest('.person-card');
  if (!card) return;
  const person = people.find((item) => item.id === card.dataset.id);
  if (!person) return;

  if (event.target.matches('[data-field]')) {
    person[event.target.dataset.field] = event.target.dataset.field === 'number'
      ? event.target.value
      : cleanName(event.target.value);
    render();
    return;
  }

  if (event.target.matches('[data-photos]')) {
    const selected = [...event.target.files].filter(isImage);
    const remaining = Math.max(0, MAX_PHOTOS - person.photos.length);
    const accepted = selected.slice(0, remaining);
    accepted.forEach((file) => person.photos.push({ file, ext: fileExtension(file), url: URL.createObjectURL(file) }));
    render();
    if (selected.length > remaining) flash('每人最多两张，已忽略多余照片');
    else if (accepted.length) flash(`已添加 ${accepted.length} 张照片`);
    else flash('请选择图片文件');
  }
});

grid.addEventListener('click', (event) => {
  const card = event.target.closest('.person-card');
  if (!card) return;
  const personIndex = people.findIndex((item) => item.id === card.dataset.id);
  if (personIndex < 0) return;

  if (event.target.matches('[data-remove-person]')) {
    releasePerson(people[personIndex]);
    people.splice(personIndex, 1);
    render();
    return;
  }

  if (event.target.matches('[data-remove-photo]')) {
    const photoIndex = Number(event.target.dataset.removePhoto);
    const [photo] = people[personIndex].photos.splice(photoIndex, 1);
    if (photo) URL.revokeObjectURL(photo.url);
    render();
  }
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

async function bytesOf(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error('不支持的文件内容');
}

async function makeZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = await bytesOf(entry.data);
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

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function saveBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

async function buildFinalZip() {
  const entries = [];
  const rows = ['完整编号,序号,姓名,照片数量,文件名'];
  const sorted = people.slice().sort((a, b) => Number(a.number) - Number(b.number));
  sorted.forEach((person) => {
    const names = [];
    person.photos.forEach((photo, index) => {
      const name = `${photoBase(person, index)}.${photo.ext}`;
      names.push(name);
      entries.push({ name, data: photo.file });
    });
    rows.push([personCode(person), padNumber(person.number), cleanName(person.name), person.photos.length, names.join('；')].map(csvCell).join(','));
  });
  entries.unshift({ name: '照片汇总清单.csv', data: `\ufeff${rows.join('\r\n')}` });
  return makeZip(entries);
}

$('#downloadFinal').addEventListener('click', async () => {
  const issues = allIssues();
  if (issues.length) {
    flash(issues[0]);
    return;
  }
  const button = $('#downloadFinal');
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    const blob = await buildFinalZip();
    const date = new Date().toISOString().slice(0, 10);
    saveBlob(blob, `${people.length}人照片最终版-${date}.zip`);
    flash('最终总压缩包已生成');
  } catch (error) {
    console.error(error);
    flash('生成失败，照片过大时建议分批处理');
  } finally {
    button.disabled = false;
    button.textContent = '下载最终总 ZIP';
  }
});

window.addEventListener('beforeunload', () => people.forEach(releasePerson));
render();
