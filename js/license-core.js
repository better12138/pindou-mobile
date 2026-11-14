// 兑换码核心算法与本地额度账本。
// 与 PC 端 src/license.ts 必须保持一致：
//   新码：PB- 前缀 + 12 位（1 位套餐 + 7 位随机 + 4 位签名），签名带域分隔 "PB|"
//   旧码：12 位（8 位随机 + 4 位签名），签名不带分隔，兑换 1 次
// 两端同源部署（/ 与 /m/）时共用下面这个 localStorage 键，因此余额与已用码天然共享。
export const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SECRET = 'pindou-xhs-2026';
export const PREFIX = 'PB';
export const PAYLOAD_LENGTH = 8;
export const SIGNATURE_LENGTH = 4;
export const CODE_LENGTH = PAYLOAD_LENGTH + SIGNATURE_LENGTH;
export const STORAGE_KEY = 'perler-beads-generator:credits';

/** 套餐编码：A 标准 20 次、B 开业 30 次、C 补偿 1 次。 */
export const PLANS = {
  A: { credits: 20, label: '标准版 20 次' },
  B: { credits: 30, label: '开业版 30 次' },
  C: { credits: 1, label: '补偿 1 次' },
};

function hash32(text, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function signature(payload, withDomain) {
  const base = withDomain ? `${PREFIX}|${payload}` : payload;
  let result = '';
  for (let index = 0; index < SIGNATURE_LENGTH; index += 1) {
    const value = hash32(`${SECRET}|${base}|${index}`, (index + 1) * 0x9e3779b1);
    result += ALPHABET[value % ALPHABET.length];
  }
  return result;
}

/** 去掉空格、横线、小写，得到纯大写字母数字串；保留 PB / PD 前缀用于分辨新老码。 */
export function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function onlyAlphabet(text) {
  return [...text].every((char) => ALPHABET.includes(char));
}

/**
 * 解析兑换码，不产生副作用。
 * @returns {{ok:true, code:string, plan:string|null, credits:number, legacy:boolean} | {ok:false, reason:'format'|'invalid'}}
 */
export function parseCode(raw) {
  const normalized = normalizeCode(raw);
  let body = normalized;
  if (normalized.startsWith(PREFIX) && normalized.length === PREFIX.length + CODE_LENGTH) {
    body = normalized.slice(PREFIX.length);
  } else if (normalized.startsWith('PD') && normalized.length === 2 + CODE_LENGTH) {
    body = normalized.slice(2);
  }
  if (body.length !== CODE_LENGTH || !onlyAlphabet(body)) return { ok: false, reason: 'format' };

  const payload = body.slice(0, PAYLOAD_LENGTH);
  const tail = body.slice(PAYLOAD_LENGTH);

  // 新码：首位是套餐编码，签名带域分隔，避免与旧码歧义。
  const plan = payload[0];
  if (PLANS[plan] && signature(payload, true) === tail) {
    return { ok: true, code: `${PREFIX}${body}`, plan, credits: PLANS[plan].credits, legacy: false };
  }
  if (signature(payload, false) === tail) {
    return { ok: true, code: body, plan: null, credits: 1, legacy: true };
  }
  return { ok: false, reason: 'invalid' };
}

/** 展示用格式：新码 PB-XXXX-XXXX-XXXX，旧码 XXXX-XXXX-XXXX。 */
export function formatCode(raw) {
  const normalized = normalizeCode(raw);
  const isPrefixed = normalized.startsWith(PREFIX) && normalized.length > PREFIX.length;
  const body = isPrefixed ? normalized.slice(PREFIX.length) : normalized;
  if (!body) return '';
  const spaced = body.replace(/(.{4})/g, '$1-').replace(/-$/, '');
  return isPrefixed ? `${PREFIX}-${spaced}` : spaced;
}

/** 兑换码输入是否已经够长，用来控制按钮可用状态（不做有效性判断）。 */
export function isCodeComplete(raw) {
  const normalized = normalizeCode(raw);
  return normalized.length >= CODE_LENGTH;
}

/* ---------------- 本地账本（与 PC 端共用） ---------------- */

const listeners = new Set();

function readLedger() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { credits: 0, usedCodes: [] };
    const parsed = JSON.parse(raw);
    return {
      credits: Number.isFinite(parsed.credits) ? Math.max(0, Math.floor(Number(parsed.credits))) : 0,
      usedCodes: Array.isArray(parsed.usedCodes)
        ? parsed.usedCodes.filter((code) => typeof code === 'string')
        : [],
    };
  } catch {
    return { credits: 0, usedCodes: [] };
  }
}

function writeLedger(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式或配额满时静默失败，调用方会看到余额没变
  }
  notify();
}

function notify() {
  for (const listener of listeners) listener();
}

export function getCredits() {
  return readLedger().credits;
}

export function getUsedCodes() {
  return readLedger().usedCodes;
}

/** 订阅余额变化：本页写入、以及另一端（/ 或 /m/）写入都会触发。 */
export function subscribeCredits(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) notify();
  });
}

/**
 * 兑换：同源两端共用 usedCodes，因此一张码在两端口径下只会成功一次。
 * @returns {{ok:true, credits:number, granted:number, plan:string|null} | {ok:false, reason:'format'|'invalid'|'used'}}
 */
export function redeem(raw) {
  const parsed = parseCode(raw);
  if (!parsed.ok) return parsed;
  const state = readLedger();
  if (state.usedCodes.includes(parsed.code)) return { ok: false, reason: 'used' };
  const next = {
    credits: state.credits + parsed.credits,
    usedCodes: [...state.usedCodes, parsed.code],
  };
  writeLedger(next);
  return { ok: true, credits: next.credits, granted: parsed.credits, plan: parsed.plan };
}

/** 导出前扣 1 次；额度不足返回 false。 */
export function spendCredit(count = 1) {
  const state = readLedger();
  const amount = Math.max(1, Math.floor(count));
  if (state.credits < amount) return false;
  writeLedger({ credits: state.credits - amount, usedCodes: state.usedCodes });
  return true;
}
