// 授权与余额模块（移动端）：兑换弹层、余额展示、导出前扣次。
// 账本与 PC 端共用 localStorage，因此同源部署时一张码只会计一次、余额共享。
import {
  formatCode,
  getCredits,
  isCodeComplete,
  normalizeCode,
  parseCode,
  redeem,
  spendCredit,
  subscribeCredits,
} from './license-core.js';
import { activeOffer, getPricing, loadPricing } from './pricing.js';

const $ = (selector) => document.querySelector(selector);

let toastFn = () => {};
let initialized = false;

function renderBalance() {
  const credits = getCredits();
  document.querySelectorAll('[data-credit-balance]').forEach((node) => {
    node.textContent = String(credits);
  });
  const chip = $('#btn-credit');
  if (chip) chip.textContent = credits > 0 ? `额度 ${credits}` : '兑换';
}

function renderPrice() {
  const note = $('#credit-price-note');
  if (!note) return;
  const config = getPricing();
  const offer = activeOffer(config);
  const promo = config.promo || {};
  const lines = [
    `${offer.name} ${offer.price} 元 / ${offer.credits} 次`,
    offer.isPromo && promo.endsAt ? `开业价截止：${promo.endsAt}` : '',
    `购买方式：${config.buyChannel}`,
    config.buyNote || '',
  ].filter(Boolean);
  note.innerHTML = '';
  for (const line of lines) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    note.appendChild(paragraph);
  }
}

function setMessage(text, isError = false) {
  const node = $('#credit-message');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('error', isError);
}

function openSheet() {
  renderPrice();
  renderBalance();
  setMessage('');
  const sheet = $('#sheet-credit');
  if (sheet) sheet.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  const sheet = $('#sheet-credit');
  if (sheet) sheet.setAttribute('aria-hidden', 'true');
}

function submit() {
  const input = $('#credit-input');
  if (!input) return;
  const value = input.value;
  const result = redeem(value);
  if (result.ok) {
    input.value = '';
    setMessage(`兑换成功，获得 ${result.granted} 次，当前剩余 ${result.credits} 次。`);
    toastFn(`已到账 ${result.granted} 次导出`);
    renderBalance();
    return;
  }
  const message =
    result.reason === 'format'
      ? '兑换码格式不对：应为 PB-XXXX-XXXX-XXXX 或 12 位旧码。'
      : result.reason === 'used'
        ? '这张兑换码已经兑换过了（电脑端和手机端共用同一份额度）。'
        : '兑换码无效，请核对后重试。';
  setMessage(message, true);
}

/**
 * 导出前的闸门：有额度就扣 1 次并返回 true；没额度打开兑换弹层并返回 false。
 * @param {'png'|'print'|'csv'} kind 仅用于提示文案
 */
export function requireExport(kind = 'png') {
  if (spendCredit(1)) {
    renderBalance();
    return true;
  }
  const label = kind === 'print' ? '打印分页图纸' : kind === 'csv' ? '导出用量 CSV' : '导出图纸';
  toastFn(`${label}需要 1 次额度，先兑换一个码`, { error: true, duration: 2800 });
  openSheet();
  setMessage('当前额度不足，输入兑换码后即可继续。', true);
  return false;
}

/**
 * 移动端 → PC 端：带上当前图纸名称和尺寸。
 * 因为两端图纸格式不同，这里跳到电脑端首页（不直接进编辑器），由首页提示「未自动带入」。
 */
function buildPcHref(project) {
  const params = new URLSearchParams({ from: 'mobile' });
  if (project) {
    params.set('name', project.name || '未命名图纸');
    params.set('w', String(project.width || ''));
    params.set('h', String(project.height || ''));
  }
  return `/?${params.toString()}`;
}

export function bindPcLink(getProject) {
  const link = $('#btn-open-pc');
  if (!link) return;
  const update = () => {
    link.setAttribute('href', buildPcHref(getProject()));
  };
  link.addEventListener('pointerenter', update);
  link.addEventListener('focus', update);
  link.addEventListener('click', update);
}

/** 页面加载时初始化；toast 由 app.js 注入，保持提示样式统一。 */
export function initEntitlement(options = {}) {
  toastFn = options.toast || toastFn;
  if (initialized) {
    renderBalance();
    return;
  }
  initialized = true;

  const chip = $('#btn-credit');
  if (chip) chip.addEventListener('click', openSheet);

  const entry = $('#btn-open-credit');
  if (entry) entry.addEventListener('click', openSheet);

  const sheet = $('#sheet-credit');
  if (sheet) {
    sheet.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) closeSheet();
    });
  }

  const input = $('#credit-input');
  if (input) {
    input.addEventListener('input', () => {
      const formatted = formatCode(input.value);
      if (formatted !== input.value) input.value = formatted;
      const submitButton = $('#btn-credit-submit');
      if (submitButton) submitButton.disabled = !isCodeComplete(input.value);
      setMessage('');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }

  const submitButton = $('#btn-credit-submit');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.addEventListener('click', submit);
  }

  subscribeCredits(renderBalance);
  renderBalance();
  loadPricing().then(renderPrice);
  renderPrice();
}

/** 供 app.js 在切到设置页时刷新展示。 */
export function refreshEntitlement() {
  renderBalance();
  renderPrice();
}

export function openCreditSheet() {
  openSheet();
}

export { getCredits, normalizeCode, parseCode };
