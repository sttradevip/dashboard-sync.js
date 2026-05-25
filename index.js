const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const CHAT_ID = process.env.SIGNALS_CHAT_ID || '-1002840761137';
const THREAD_ID = Number(process.env.SIGNALS_THREAD_ID || 12385);

const SYMBOLS = String(
  process.env.SIGNAL_SYMBOLS ||
  'TSLA,NVDA,AMZN,SPY,QQQ,META,AAPL,AMD,COIN,PLTR,NFLX'
)
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const activeTrades = new Map();
const sentToday = new Set();

const SCAN_INTERVAL_MS = 2 * 60 * 1000;
const UPDATE_INTERVAL_MS = 30 * 1000;

const MIN_CONTRACT_PRICE = 1.50;
const MAX_CONTRACT_PRICE = 2.50;

const MIN_VOLUME = 1000;
const MIN_DELTA = 0.25;
const MAX_DELTA = 0.45;
const MIN_GAMMA = 0.02;
const MAX_DISTANCE_PERCENT = 3;
const MAX_SPREAD_PERCENT = 15;

const TAKE_PROFIT_DOLLARS = 0.40;
const STOP_LOSS_DOLLARS = 0.30;
const UPDATE_STEP = 0.10;
const NEAR_STOP_DISTANCE = 0.05;

// =====================
// Helpers
// =====================

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return `${Number(n).toFixed(2)}%`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyMemoryIfNeeded() {
  const key = todayKey();

  for (const item of sentToday) {
    if (!item.startsWith(key)) {
      sentToday.delete(item);
    }
  }
}

function getContractType(item) {
  return String(item?.details?.contract_type || '').toUpperCase();
}

function getStrike(item) {
  return item?.details?.strike_price;
}

function getExpiration(item) {
  return item?.details?.expiration_date || null;
}

function getContractTicker(item) {
  return item?.details?.ticker || item?.ticker || null;
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getDelta(item) {
  return item?.greeks?.delta;
}

function getGamma(item) {
  return item?.greeks?.gamma;
}

function getTheta(item) {
  return item?.greeks?.theta;
}

function getIV(item) {
  return item?.implied_volatility;
}

function getBid(item) {
  return Number(item?.last_quote?.bid || 0);
}

function getAsk(item) {
  return Number(item?.last_quote?.ask || 0);
}

function getLastTradePrice(item) {
  return Number(item?.last_trade?.price || 0);
}

function getMidPrice(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }

  const last = getLastTradePrice(item);

  if (last > 0) {
    return Number(last.toFixed(2));
  }

  return 0;
}

function distancePercent(strike, stockPrice) {
  const s = Number(strike);
  const p = Number(stockPrice);

  if (!s || !p || isNaN(s) || isNaN(p)) {
    return null;
  }

  return Math.abs(((s - p) / p) * 100);
}

function daysToExpiration(dateStr) {
  if (!dateStr) return 999;

  const now = new Date();
  const exp = new Date(dateStr + 'T23:59:59Z');

  return Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function gammaText(gamma) {
  const g = Number(gamma);

  if (gamma === undefined || gamma === null || isNaN(g)) return 'غير متوفر';
  if (g >= 0.08) return 'مرتفع جدًا';
  if (g >= 0.04) return 'مرتفع';
  if (g >= 0.02) return 'متوسط';

  return 'منخفض';
}

function sideArabic(side) {
  return side === 'CALL' ? 'كول' : 'بوت';
}

function pnlPercent(entry, current) {
  return (((current - entry) / entry) * 100).toFixed(2);
}

// =====================
// Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || data?.message || 'API Error');
  }

  return data;
}

async function getStockSnapshot(symbol) {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);
  const r = data?.results?.[0];

  if (!r) return null;

  const change = r.o ? ((r.c - r.o) / r.o) * 100 : null;

  return {
    symbol,
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    change
  };
}
async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

async function getOptionSnapshot(contractTicker) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${contractTicker}?apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || data;
}

// =====================
// Image Card
// =====================

async function createTradeImage(type) {
  const color = type === 'CALL' ? '#00ff99' : '#ff2d55';

  const svg = `
  <svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="50%" r="70%">
        <stop offset="0%" stop-color="#111936"/>
        <stop offset="100%" stop-color="#050816"/>
      </radialGradient>
    </defs>

    <rect width="800" height="450" fill="url(#bg)" />

    <rect
      x="20"
      y="20"
      width="760"
      height="410"
      rx="30"
      ry="30"
      fill="none"
      stroke="${color}"
      stroke-width="8"
    />

    <circle cx="400" cy="225" r="115" fill="${color}" opacity="0.16" />
    <circle cx="400" cy="225" r="70" fill="${color}" opacity="0.22" />

    <line x1="160" y1="225" x2="640" y2="225" stroke="${color}" stroke-width="4" opacity="0.35"/>
    <line x1="400" y1="80" x2="400" y2="370" stroke="${color}" stroke-width="4" opacity="0.18"/>
  </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// =====================
// Scoring Engine
// =====================

function stockMomentumSide(stock) {
  if (!stock || stock.change === null || stock.change === undefined) {
    return 'NEUTRAL';
  }

  if (stock.change > 0.15) return 'CALL';
  if (stock.change < -0.15) return 'PUT';

  return 'NEUTRAL';
}

function spreadPercent(item) {
  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);

  if (!bid || !ask || !mid) return 999;

  return ((ask - bid) / mid) * 100;
}

function isCandidateContract(item, stock) {
  const type = getContractType(item);
  const strike = getStrike(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const gamma = Number(getGamma(item) || 0);
  const mid = getMidPrice(item);
  const dist = distancePercent(strike, stock.price);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));
  const momentum = stockMomentumSide(stock);

  if (!['CALL', 'PUT'].includes(type)) return false;
  if (!strike || dist === null) return false;

  if (mid < MIN_CONTRACT_PRICE || mid > MAX_CONTRACT_PRICE) return false;
  if (volume < MIN_VOLUME) return false;
  if (delta < MIN_DELTA || delta > MAX_DELTA) return false;
  if (gamma < MIN_GAMMA) return false;
  if (dist > MAX_DISTANCE_PERCENT) return false;
  if (spread > MAX_SPREAD_PERCENT) return false;

  // لا نرسل صفقة عكس الاتجاه إلا إذا السيولة قوية جدًا
  if (momentum !== 'NEUTRAL' && type !== momentum) {
    const strongContrarian =
      volume > oi * 4 &&
      gamma >= 0.04 &&
      dist <= 1;

    if (!strongContrarian) return false;
  }

  // لا نختار عقود منتهية أو بعيدة جدًا
  if (dte < 0 || dte > 10) return false;

  return true;
}

function contractScore(item, stock) {
  const type = getContractType(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const mid = getMidPrice(item);
  const dist = distancePercent(getStrike(item), stock.price);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));
  const momentum = stockMomentumSide(stock);

  let score = 0;

  // السيولة
  score += Math.min(volume / 100, 500);
  score += Math.min(oi / 100, 200);

  // دخول جديد
  if (volume > oi) score += 300;
  if (volume > oi * 2) score += 200;
  if (volume > oi * 4) score += 200;

  // Gamma
  if (gamma >= 0.08) score += 350;
  else if (gamma >= 0.04) score += 250;
  else if (gamma >= 0.02) score += 120;

  // Delta
  if (delta >= 0.28 && delta <= 0.40) score += 250;
  else if (delta >= 0.25 && delta <= 0.45) score += 150;

  // قرب السعر
  if (dist !== null) {
    if (dist <= 0.5) score += 300;
    else if (dist <= 1) score += 220;
    else if (dist <= 2) score += 120;
  }

  // السعر المطلوب
  if (mid >= 1.5 && mid <= 2.5) score += 250;

  // السبريد
  if (spread <= 6) score += 180;
  else if (spread <= 10) score += 100;
  else if (spread <= 15) score += 40;

  // اليومي ثم الأسبوعي
  if (dte <= 1) score += 150;
  else if (dte <= 5) score += 100;
  else if (dte <= 10) score += 50;

  // توافق الاتجاه
  if (momentum !== 'NEUTRAL' && type === momentum) {
    score += 250;
  }

  return Math.round(score);
}
function selectBestContract(symbol, stock, chain) {
  const candidates = chain
    .filter(item => isCandidateContract(item, stock))
    .map(item => ({
      item,
      score: contractScore(item, stock)
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return null;
  }

  const best = candidates[0];
  const item = best.item;

  const type = getContractType(item);
  const strike = getStrike(item);
  const expiration = getExpiration(item);
  const contractTicker = getContractTicker(item);

  const entry = getMidPrice(item);

  if (!contractTicker || !entry) {
    return null;
  }

  const stop = Number((entry - STOP_LOSS_DOLLARS).toFixed(2));
  const target = Number((entry + TAKE_PROFIT_DOLLARS).toFixed(2));

  if (stop <= 0) {
    return null;
  }

  return {
    symbol,
    type,
    strike,
    expiration,
    contractTicker,
    entry,
    current: entry,
    lastUpdatePrice: entry,
    stop,
    target,
    score: best.score,
    volume: getVolume(item),
    oi: getOI(item),
    delta: getDelta(item),
    gamma: getGamma(item),
    theta: getTheta(item),
    iv: getIV(item),
    bid: getBid(item),
    ask: getAsk(item),
    dte: daysToExpiration(expiration),
    warnedStop: false,
    status: 'OPEN'
  };
}

function tradeKey(symbol) {
  return String(symbol || '').toUpperCase();
}

function alreadyHasActiveTrade(symbol) {
  return activeTrades.has(tradeKey(symbol));
}

function markTradeActive(trade) {
  activeTrades.set(tradeKey(trade.symbol), trade);
}

function removeTrade(symbol) {
  activeTrades.delete(tradeKey(symbol));
}

function wasSentToday(trade) {
  const key =
    `${todayKey()}-${trade.symbol}-${trade.type}-${trade.strike}-${trade.expiration}`;

  return sentToday.has(key);
}

function markSentToday(trade) {
  const key =
    `${todayKey()}-${trade.symbol}-${trade.type}-${trade.strike}-${trade.expiration}`;

  sentToday.add(key);
}

function tradeTitle(trade) {
  return `${trade.symbol} ${trade.type} ${trade.strike}`;
}

async function sendTradeEntry(trade) {
  const image = await createTradeImage(trade.type);

  const text =
`🚨 صفقة ST VIP

📊 السهم: ${trade.symbol}
📈 النوع: ${trade.type} / ${sideArabic(trade.type)}
🎯 السترايك: ${trade.strike}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
🎯 الهدف: $${fmtPrice(trade.target)}
🛑 الوقف: $${fmtPrice(trade.stop)}

💵 Bid: $${fmtPrice(trade.bid)}
💵 Ask: $${fmtPrice(trade.ask)}

📦 Volume: ${fmt(trade.volume)}
📂 OI: ${fmt(trade.oi)}

Δ Delta: ${
  trade.delta !== undefined && trade.delta !== null
    ? Number(trade.delta).toFixed(2)
    : 'غير متوفر'
}
Γ Gamma: ${gammaText(trade.gamma)}
IV: ${
  trade.iv !== undefined && trade.iv !== null
    ? fmtPercent(Number(trade.iv) * 100)
    : 'غير متوفر'
}

⭐ جودة الفلترة: ${trade.score}

🔥 ST TRADE VIP`;

  await bot.sendPhoto(CHAT_ID, image, {
    caption: text,
    message_thread_id: THREAD_ID
  });
}

async function sendTradeUpdate(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`🚀 تحديث الصفقة

📊 ${tradeTitle(trade)}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
💵 الحالي: $${fmtPrice(trade.current)}

✅ الربح الحالي: ${percent}%

🎯 الهدف: $${fmtPrice(trade.target)}
🛑 الوقف: $${fmtPrice(trade.stop)}

🔥 ST TRADE VIP`;

  await bot.sendMessage(CHAT_ID, text, {
    message_thread_id: THREAD_ID
  });
}

async function sendNearStopWarning(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`⚠️ تنبيه مهم

الصفقة قريبة من وقف الخسارة

📊 ${tradeTitle(trade)}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
💵 الحالي: $${fmtPrice(trade.current)}

📉 الخسارة الحالية: ${percent}%

🛑 الوقف: $${fmtPrice(trade.stop)}`;

  await bot.sendMessage(CHAT_ID, text, {
    message_thread_id: THREAD_ID
  });
}

async function sendStopHit(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`❌ تم ضرب وقف الخسارة

📊 ${tradeTitle(trade)}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
💵 الإغلاق: $${fmtPrice(trade.current)}

📉 الخسارة النهائية: ${percent}%`;

  await bot.sendMessage(CHAT_ID, text, {
    message_thread_id: THREAD_ID
  });
}

async function sendTargetHit(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`🎯 تم تحقيق الهدف

📊 ${tradeTitle(trade)}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
💵 السعر الحالي: $${fmtPrice(trade.current)}

📈 الربح النهائي: ${percent}%

🔥 ST TRADE VIP`;

  await bot.sendMessage(CHAT_ID, text, {
    message_thread_id: THREAD_ID
  });
}
async function scanForTrades() {
  resetDailyMemoryIfNeeded();

  for (const symbol of SYMBOLS) {
    try {
      if (alreadyHasActiveTrade(symbol)) {
        continue;
      }

      const stock = await getStockSnapshot(symbol);

      if (!stock) {
        continue;
      }

      const chain = await getOptionsChain(symbol);

      if (!chain.length) {
        continue;
      }

      const trade = selectBestContract(symbol, stock, chain);

      if (!trade) {
        continue;
      }

      if (wasSentToday(trade)) {
        continue;
      }

      markTradeActive(trade);
      markSentToday(trade);

      await sendTradeEntry(trade);

      console.log(
        `✅ New trade sent: ${trade.symbol} ${trade.type} ${trade.strike}`
      );

    } catch (err) {
      console.error(
        `Scan Error ${symbol}:`,
        err.message
      );
    }
  }
}

async function refreshTradePrice(trade) {
  const snapshot = await getOptionSnapshot(trade.contractTicker);

  const current = getMidPrice(snapshot);

  if (!current || current <= 0) {
    return null;
  }

  return Number(current.toFixed(2));
}

async function updateActiveTrades() {
  for (const [symbol, trade] of activeTrades.entries()) {
    try {
      if (trade.status !== 'OPEN') {
        continue;
      }

      const current = await refreshTradePrice(trade);

      if (!current) {
        continue;
      }

      trade.current = current;

      if (trade.current <= trade.stop) {
        trade.status = 'STOPPED';

        await sendStopHit(trade);

        removeTrade(symbol);

        continue;
      }

      if (
        !trade.warnedStop &&
        trade.current <= trade.stop + NEAR_STOP_DISTANCE &&
        trade.current > trade.stop
      ) {
        trade.warnedStop = true;

        await sendNearStopWarning(trade);
      }

      if (trade.current >= trade.target) {
        trade.status = 'TARGET';

        await sendTargetHit(trade);

        removeTrade(symbol);

        continue;
      }

      if (trade.current >= trade.lastUpdatePrice + UPDATE_STEP) {
        await sendTradeUpdate(trade);

        trade.lastUpdatePrice = trade.current;
      }

    } catch (err) {
      console.error(
        `Update Error ${symbol}:`,
        err.message
      );
    }
  }
}

// =====================
// Bot Commands
// =====================

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '🚀 ST Signals Bot يعمل بنجاح'
  );
});

bot.onText(/\/status/, async (msg) => {
  const lines = [];

  lines.push('📊 حالة بوت الصفقات');
  lines.push('');
  lines.push(`عدد الصفقات المفتوحة: ${activeTrades.size}`);
  lines.push('');

  if (!activeTrades.size) {
    lines.push('لا توجد صفقات مفتوحة حالياً.');
  } else {
    for (const [, trade] of activeTrades.entries()) {
      lines.push(
        `${trade.symbol} ${trade.type} ${trade.strike} | الدخول $${fmtPrice(trade.entry)} | الحالي $${fmtPrice(trade.current)}`
      );
    }
  }

  await bot.sendMessage(
    msg.chat.id,
    lines.join('\n')
  );
});

bot.onText(/\/scan/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '🔎 جاري فحص السوق الآن...'
  );

  await scanForTrades();

  await bot.sendMessage(
    msg.chat.id,
    '✅ انتهى الفحص.'
  );
});

bot.onText(/\/stoptrade (.+)/, async (msg, match) => {
  const symbol = String(match[1] || '')
    .trim()
    .toUpperCase();

  if (!activeTrades.has(symbol)) {
    await bot.sendMessage(
      msg.chat.id,
      `لا توجد صفقة مفتوحة على ${symbol}`
    );

    return;
  }

  removeTrade(symbol);

  await bot.sendMessage(
    msg.chat.id,
    `🛑 تم حذف الصفقة المفتوحة على ${symbol}`
  );
});

// =====================
// Start Loops
// =====================

scanForTrades();

setInterval(
  scanForTrades,
  SCAN_INTERVAL_MS
);

setInterval(
  updateActiveTrades,
  UPDATE_INTERVAL_MS
);

console.log('🚀 ST Real Options Signals Bot Started');
