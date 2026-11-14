// 价目配置：从站点根目录 pricing.json 读取，端点可改（改价、结束开业价都不需要重新发版）。
// 读取失败时用下面的兜底值，保证离线也能显示价格。
const FALLBACK = {
  currency: 'CNY',
  standard: { name: '标准版', price: 9.9, credits: 20, plan: 'A' },
  promo: {
    name: '开业版',
    price: 9.9,
    credits: 30,
    plan: 'B',
    enabled: true,
    endsAt: null,
    endCondition: '',
  },
  buyChannel: '小红书私信 @拼豆图纸生成器',
  buyNote: '付款后收到带 PB- 前缀的兑换码，在电脑端或手机端输入即可，两端额度共用。',
  buyUrl: '',
};

let pricing = FALLBACK;
let loaded = null;

function merge(raw) {
  if (!raw || typeof raw !== 'object') return FALLBACK;
  return {
    ...FALLBACK,
    ...raw,
    standard: { ...FALLBACK.standard, ...(raw.standard || {}) },
    promo: { ...FALLBACK.promo, ...(raw.promo || {}) },
  };
}

async function fetchOnce() {
  for (const url of ['/pricing.json', './pricing.json']) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      pricing = merge(await response.json());
      return pricing;
    } catch {
      // 换下一个地址
    }
  }
  return pricing;
}

/** 启动时调用一次；重复调用复用同一个 Promise。 */
export function loadPricing() {
  if (!loaded) loaded = fetchOnce();
  return loaded;
}

export function getPricing() {
  return pricing;
}

/** 当前生效的售卖档位：开业期未结束用 promo，否则用 standard。 */
export function activeOffer(config = pricing) {
  const promo = config.promo || {};
  const endsAt = promo.endsAt ? Date.parse(promo.endsAt) : NaN;
  const promoActive = promo.enabled !== false && (!Number.isFinite(endsAt) || Date.now() < endsAt);
  return promoActive ? { ...promo, isPromo: true } : { ...config.standard, isPromo: false };
}

export function offerLabel(config = pricing) {
  const offer = activeOffer(config);
  return `${offer.price} 元 / ${offer.credits} 次${offer.isPromo ? '（开业期）' : ''}`;
}
