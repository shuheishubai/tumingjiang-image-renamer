import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const [keysArgument, deliveryArgument] = process.argv.slice(2);
if (!keysArgument || !deliveryArgument) {
  throw new Error('Usage: node generate-bootstrap.mjs <keys.json> <delivery.txt>');
}

const keysPath = resolve(keysArgument);
const deliveryPath = resolve(deliveryArgument);
if (existsSync(keysPath) || existsSync(deliveryPath)) {
  throw new Error('Refusing to overwrite an existing bootstrap file.');
}

mkdirSync(dirname(keysPath), { recursive: true });
mkdirSync(dirname(deliveryPath), { recursive: true });

const rawKey = `TJ-OWNER-${randomBytes(28).toString('base64url')}`;
const salt = randomBytes(18);
const hash = scryptSync(rawKey, salt, 64, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const record = {
  id: randomUUID(),
  label: '站长恢复密钥',
  role: 'owner',
  lookup: createHash('sha256').update(rawKey, 'utf8').digest('hex').slice(0, 24),
  salt: salt.toString('base64url'),
  hash: hash.toString('base64url'),
  lastFour: [...rawKey].slice(-4).join(''),
  createdAt: new Date().toISOString(),
  expiresAt: null,
  disabled: false
};

writeFileSync(keysPath, `${JSON.stringify({ version: 1, keys: [record] }, null, 2)}\n`, { mode: 0o600 });
writeFileSync(deliveryPath, [
  '片刻网站——首次管理员恢复密钥',
  '',
  rawKey,
  '',
  '用途：登录网站，以及进入 /access/manage.html 创建或停用分享密钥。',
  '请把密钥保存到你自己的密码管理器中，不要发到群聊。',
  '确认保存后，可以删除本文件。',
  ''
].join('\r\n'), { mode: 0o600 });
