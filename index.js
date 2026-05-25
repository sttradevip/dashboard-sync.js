const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const CHAT_ID = process.env.SIGNALS_CHAT_ID || '-1002840761137';
const THREAD_ID = Number(process.env.SIGNALS_THREAD_ID || 12385);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const SYMBOLS = String(
  process.env.SIGNAL_SYMBOLS ||
  'TSLA,NVDA,AMZN,SPY,QQQ,META,AAPL,AMD,COIN,PLTR,NFLX'
)
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const activeTrades = new Map();
const sentToday = new Set();
const blockedSymbols = new Set();

let botPaused = false;

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

function isAdmin(msg) {
  const fromId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');

  return ADMIN_IDS.includes(fromId) || ADMIN_IDS.includes(chatId);
}

function sendToSameTopic(msg, text) {
  return bot.sendMessage(
    msg.chat.id,
    text,
    {
      message_thread_id: msg.message_thread_id
    }
  );
}

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

  return Math.ceil(
    (exp.getTime() - now.getTime()) /
    (1000 * 60 * 60 * 24)
  );
}

function gammaText(gamma) {
  const g = Number(gamma);

  if (gamma === undefined || gamma === null || isNaN(g)) {
    return 'غير متوفر';
  }

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

function isETF(symbol) {
  return ['SPY', 'QQQ'].includes(String(symbol).toUpperCase());
}

function isAllowedSignalTime(symbol) {
  const now = new Date();

  const saTime = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'Asia/Riyadh'
    })
  );

  const hour = saTime.getHours();
  const minute = saTime.getMinutes();
  const totalMinutes = hour * 60 + minute;

  const start = 16 * 60 + 30; // 4:30 PM Saudi
  const stocksEnd = 23 * 60; // 11:00 PM Saudi
  const etfEnd = 24 * 60; // 12:00 AM Saudi

  if (totalMinutes < start) return false;

  if (isETF(symbol)) {
    return totalMinutes <= etfEnd;
  }

  return totalMinutes <= stocksEnd;
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
    throw new Error(
      data?.error ||
      data?.message ||
      'API Error'
    );
  }

  return data;
}

async function isMarketOpenNow() {
  try {
    const url =
      `https://api.massive.com/v1/marketstatus/now?apiKey=${API_KEY}`;

    const data = await apiGet(url);

    return (
      data?.market === 'open' ||
      data?.exchanges?.nasdaq === 'open' ||
      data?.exchanges?.nyse === 'open'
    );
  } catch (err) {
    console.error('Market Status Error:', err.message);
    return false;
  }
}

async function getStockSnapshot(symbol) {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);
  const r = data?.results?.[0];

  if (!r) return null;

  const change = r.o
    ? ((r.c - r.o) / r.o) * 100
    : null;

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

  if (momentum !== 'NEUTRAL' && type !== momentum) {
    const strongContrarian =
      volume > oi * 4 &&
      gamma >= 0.04 &&
      dist <= 1;

    if (!strongContrarian) return false;
  }

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

  score += Math.min(volume / 100, 500);
  score += Math.min(oi / 100, 200);

  if (volume > oi) score += 300;
  if (volume > oi * 2) score += 200;
  if (volume > oi * 4) score += 200;

  if (gamma >= 0.08) score += 350;
  else if (gamma >= 0.04) score += 250;
  else if (gamma >= 0.02) score += 120;

  if (delta >= 0.28 && delta <= 0.40) score += 250;
  else if (delta >= 0.25 && delta <= 0.45) score += 150;

  if (dist !== null) {
    if (dist <= 0.5) score += 300;
    else if (dist <= 1) score += 220;
    else if (dist <= 2) score += 120;
  }

  if (mid >= 1.5 && mid <= 2.5) score += 250;

  if (spread <= 6) score += 180;
  else if (spread <= 10) score += 100;
  else if (spread <= 15) score += 40;

  if (dte <= 1) score += 150;
  else if (dte <= 5) score += 100;
  else if (dte <= 10) score += 50;

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

  if (!candidates.length) return null;

  const best = candidates[0];
  const item = best.item;

  const type = getContractType(item);
  const strike = getStrike(item);
  const expiration = getExpiration(item);
  const contractTicker = getContractTicker(item);
  const entry = getMidPrice(item);

  if (!contractTicker || !entry) return null;

  const stop = Number((entry - STOP_LOSS_DOLLARS).toFixed(2));
  const target = Number((entry + TAKE_PROFIT_DOLLARS).toFixed(2));

  if (stop <= 0) return null;

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
// =====================
// Trade Messages
// =====================

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

// =====================
// Scanner
// =====================

async function scanSingleSymbol(symbol, force = false) {
  symbol = String(symbol || '').trim().toUpperCase();

  if (!symbol) {
    return {
      ok: false,
      message: '⚠️ الرمز غير صحيح.'
    };
  }

  if (botPaused && !force) {
    return {
      ok: false,
      message: '⏸ البوت متوقف عن طرح صفقات جديدة.'
    };
  }

  if (!force && blockedSymbols.has(symbol)) {
    return {
      ok: false,
      message: `⛔ ${symbol} موقوف من طرح الصفقات.`
    };
  }

  if (alreadyHasActiveTrade(symbol)) {
    return {
      ok: false,
      message: `⚠️ يوجد صفقة مفتوحة مسبقًا على ${symbol}.`
    };
  }

  const marketOpen = await isMarketOpenNow();

  if (!marketOpen) {
    return {
      ok: false,
      message: '⛔ السوق مغلق حالياً، لا يتم طرح صفقات.'
    };
  }

  if (!isAllowedSignalTime(symbol)) {
    return {
      ok: false,
      message: `⛔ الوقت الحالي خارج وقت طرح صفقات ${symbol}.`
    };
  }

  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return {
      ok: false,
      message: `⚠️ لم أستطع جلب بيانات ${symbol}.`
    };
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return {
      ok: false,
      message: `⚠️ لا توجد عقود متاحة على ${symbol}.`
    };
  }

  const trade = selectBestContract(symbol, stock, chain);

  if (!trade) {
    return {
      ok: false,
      message: `⚠️ لا توجد صفقة قوية مطابقة للشروط على ${symbol} حالياً.`
    };
  }

  if (!force && wasSentToday(trade)) {
    return {
      ok: false,
      message: `⚠️ تم إرسال نفس صفقة ${symbol} اليوم سابقًا.`
    };
  }

  markTradeActive(trade);
  markSentToday(trade);

  await sendTradeEntry(trade);

  return {
    ok: true,
    message: `✅ تم إرسال صفقة ${symbol}.`
  };
}

async function scanForTrades() {
  resetDailyMemoryIfNeeded();

  if (botPaused) {
    console.log('⏸ Bot paused. No new trades.');
    return;
  }

  const marketOpen = await isMarketOpenNow();

  if (!marketOpen) {
    console.log('⛔ Market closed. No new trades.');
    return;
  }

  for (const symbol of SYMBOLS) {
    try {
      if (blockedSymbols.has(symbol)) continue;
      if (!isAllowedSignalTime(symbol)) continue;
      if (alreadyHasActiveTrade(symbol)) continue;

      const result = await scanSingleSymbol(symbol, false);

      if (result.ok) {
        console.log(result.message);
      }

    } catch (err) {
      console.error(`Scan Error ${symbol}:`, err.message);
    }
  }
}
// =====================
// Trade Updates
// =====================

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
      if (trade.status !== 'OPEN') continue;

      const current = await refreshTradePrice(trade);

      if (!current) continue;

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
      console.error(`Update Error ${symbol}:`, err.message);
    }
  }
}

// =====================
// Bot Commands
// =====================

bot.onText(/\/start/, async (msg) => {
  await sendToSameTopic(
    msg,
    '🚀 ST Signals Bot يعمل بنجاح'
  );
});

bot.onText(/\/pause/, async (msg) => {
  if (!isAdmin(msg)) return;

  botPaused = true;

  await sendToSameTopic(
    msg,
    '⏸ تم إيقاف طرح الصفقات الجديدة.'
  );
});

bot.onText(/\/resume/, async (msg) => {
  if (!isAdmin(msg)) return;

  botPaused = false;

  await sendToSameTopic(
    msg,
    '▶️ تم تشغيل طرح الصفقات من جديد.'
  );
});

bot.onText(/\/botstatus/, async (msg) => {
  if (!isAdmin(msg)) return;

  const openTrades = [...activeTrades.values()]
    .map(t =>
      `• ${t.symbol} ${t.type} ${t.strike} | دخول $${fmtPrice(t.entry)} | حالي $${fmtPrice(t.current)}`
    )
    .join('\n');

  await sendToSameTopic(
    msg,
`📊 حالة بوت الصفقات

الحالة:
${botPaused ? '⏸ متوقف عن طرح صفقات جديدة' : '▶️ يعمل ويبحث عن فرص'}

عدد الصفقات المفتوحة:
${activeTrades.size}

الأسهم الموقوفة:
${blockedSymbols.size ? [...blockedSymbols].join(', ') : 'لا يوجد'}

الصفقات المفتوحة:
${openTrades || 'لا توجد صفقات مفتوحة'}`
  );
});

bot.onText(/\/signal\s+([A-Za-z]{1,10})/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  await sendToSameTopic(
    msg,
    `🔎 جاري فحص ${symbol}...`
  );

  const result = await scanSingleSymbol(symbol, true);

  await sendToSameTopic(
    msg,
    result.message
  );
});

bot.onText(/\/block\s+([A-Za-z]{1,10})/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  blockedSymbols.add(symbol);

  await sendToSameTopic(
    msg,
    `⛔ تم إيقاف طرح صفقات ${symbol}.`
  );
});

bot.onText(/\/unblock\s+([A-Za-z]{1,10})/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  blockedSymbols.delete(symbol);

  await sendToSameTopic(
    msg,
    `✅ تم إعادة تفعيل صفقات ${symbol}.`
  );
});

bot.onText(/\/blocks/, async (msg) => {
  if (!isAdmin(msg)) return;

  const list = [...blockedSymbols];

  await sendToSameTopic(
    msg,
    list.length
      ? `⛔ الأسهم الموقوفة:\n${list.join('\n')}`
      : '✅ لا توجد أسهم موقوفة.'
  );
});

bot.onText(/\/stoptrade\s+([A-Za-z]{1,10})/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  if (!activeTrades.has(symbol)) {
    await sendToSameTopic(
      msg,
      `لا توجد صفقة مفتوحة على ${symbol}`
    );

    return;
  }

  removeTrade(symbol);

  await sendToSameTopic(
    msg,
    `🛑 تم حذف الصفقة المفتوحة على ${symbol}`
  );
});

bot.onText(/\/scan/, async (msg) => {
  if (!isAdmin(msg)) return;

  await sendToSameTopic(
    msg,
    '🔎 جاري فحص السوق الآن...'
  );

  await scanForTrades();

  await sendToSameTopic(
    msg,
    '✅ انتهى الفحص.'
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
