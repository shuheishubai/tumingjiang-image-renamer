import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync
} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const [keysArgument, deliveryArgument, backupDirectoryArgument] = process.argv.slice(2);
const rawKey = process.env.NEW_OWNER_KEY || '';
if (!keysArgument || !deliveryArgument || !backupDirectoryArgument || !/^\d{6}$/.test(rawKey)) {
  throw new Error('Usage: NEW_OWNER_KEY=<six-digits> node rotate-owner-key.mjs <keys.json> <delivery.txt|-> <backup-dir>');
}

const keysPath = resolve(keysArgument);
const deliveryPath = deliveryArgument === '-' ? null : resolve(deliveryArgument);
const backupDirectory = resolve(backupDirectoryArgument);
const parsed = JSON.parse(readFileSync(keysPath, 'utf8'));
if (!Array.isArray(parsed.keys)) throw new Error('Invalid key database.');
const ownerIndex = parsed.keys.findIndex((key) => key.role === 'owner' && !key.disabled);
if (ownerIndex < 0) throw new Error('Active owner key not found.');
if (parsed.keys.some((key, index) => index !== ownerIndex && key.lookup === keyLookup(rawKey))) {
  throw new Error('The requested owner key is already used by another access key.');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
copyFileSync(keysPath, join(backupDirectory, `${basename(keysPath)}.${stamp}.bak`));
if (deliveryPath && existsSync(deliveryPath)) {
  copyFileSync(deliveryPath, join(backupDirectory, `${basename(deliveryPath)}.${stamp}.bak`));
}

const salt = randomBytes(18);
const hash = scryptSync(rawKey, salt, 64, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
parsed.keys[ownerIndex] = {
  ...parsed.keys[ownerIndex],
  id: randomUUID(),
  label: '站长管理员密钥',
  lookup: keyLookup(rawKey),
  salt: salt.toString('base64url'),
  hash: hash.toString('base64url'),
  lastFour: rawKey.slice(-4),
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  disabled: false
};

atomicWrite(keysPath, `${JSON.stringify(parsed, null, 2)}\n`);
if (deliveryPath) {
  atomicWrite(deliveryPath, [
    '片刻网站——管理员密钥',
    '',
    `管理员密钥：${rawKey}`,
    '',
    '用途：进入 /access/manage.html 创建或停用普通六位访问码。',
    '这是网站总钥匙，请勿发给普通用户。',
    ''
  ].join('\r\n'));
}
console.log('Owner key rotated; plaintext was not printed.');

function keyLookup(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
