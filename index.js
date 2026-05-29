const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CHAT_ID = process.env.SIGNALS_CHAT_ID || '-1002840761137';
const THREAD_ID = Number(process.env.SIGNALS_THREAD_ID || 12385);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const SYMBOLS = String(
  process.env.SIGNAL_SYMBOLS || 'AMD,AMZN,PLTR,NVDA,TSLA,QQQ,SPY,GOOG,GOOGL'
)
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const activeTrades = new Map();
const sentToday = new Set();
const blockedSymbols = new Set();

let botPaused = false;
let scanIndex = 0;

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const SYMBOLS_PER_SCAN = 2;

const UPDATE_INTERVAL_MS = 60 * 1000;
const ANALYSIS_REFRESH_MS = 3 * 60 * 1000;

// سعر السهم من Finnhub فقط لتخفيف Massive
const FINNHUB_PRICE_CACHE_MS = 30 * 1000;
const finnhubPriceCache = new Map();

// وقف فني فقط
const TECHNICAL_STOP_CHECK_MS = 2 * 60 * 1000;
const STOP_BREAK_BUFFER_PERCENT = 0.10;
const STOP_LOOKBACK_BARS = 12;

// الهدف الثاني الفني على السهم
const TECHNICAL_TARGET_LOOKBACK_BARS = 60;
const TECHNICAL_TARGET_BUFFER_PERCENT = 0.10;

const MIN_CONTRACT_PRICE = 1.50;
const MAX_CONTRACT_PRICE = 2.50;

const MIN_VOLUME = 1000;
const MIN_DELTA = 0.25;
const MAX_DELTA = 0.45;
const MIN_GAMMA = 0.02;
const MAX_DISTANCE_PERCENT = 3;
const MAX_SPREAD_PERCENT = 15;

const TAKE_PROFIT_PERCENT = 25;
const STOP_LOSS_PERCENT = 18;

const MIN_TAKE_PROFIT_DOLLARS = 0.25;
const MIN_STOP_LOSS_DOLLARS = 0.20;

const UPDATE_STEP = 0.20;
const NEAR_STOP_DISTANCE = 0.05;

const MIN_TOTAL_SCORE = 80;
const MIN_TECHNICAL_SCORE = 60;
const MIN_CONTRACT_QUALITY_SCORE = 65;
const MIN_SMART_FLOW_SCORE = 60;

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
  if (!entry || !current) return '0.00';
  return (((current - entry) / entry) * 100).toFixed(2);
}

function tradeKey(symbol) {
  return String(symbol || '').toUpperCase();
}

function alreadyHasActiveTrade(symbol) {
  return activeTrades.has(tradeKey(symbol));
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

  const start = 16 * 60 + 30;
  const stocksEnd = 23 * 60;
  const etfEnd = 24 * 60;

  if (totalMinutes < start) return false;

  if (isETF(symbol)) {
    return totalMinutes <= etfEnd;
  }

  return totalMinutes <= stocksEnd;
}

// =====================
// Supabase
// =====================

async function saveTradeToSupabase(trade) {
  try {
    const { error } = await supabase
      .from('trade_updates')
      .insert({
        symbol: trade.symbol,
        type: trade.type,
        strike: Number(trade.strike),
        expiration: trade.expiration,

        contract_ticker: trade.contractTicker,
        message_id: trade.messageId || null,

        entry_price: trade.entry,
        current_price: trade.current,

        target_price: trade.target,
        stop_price: trade.stop,

        status: trade.status || 'OPEN',
        pnl_percent: Number(pnlPercent(trade.entry, trade.current)),

        profit_10_sent: !!trade.profit10Sent,
        profit_20_sent: !!trade.profit20Sent,
        profit_30_sent: !!trade.profit30Sent
      });

    if (error) {
      console.error('Supabase Insert Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Insert Error:', err.message);
  }
}
async function updateTradeInSupabase(trade) {
  try {
    const { error } = await supabase
      .from('trade_updates')
      .update({
        current_price: trade.current,
        status: trade.status || 'OPEN',
        pnl_percent: Number(pnlPercent(trade.entry, trade.current)),

        message_id: trade.messageId || null,
        contract_ticker: trade.contractTicker || null,

        profit_10_sent: !!trade.profit10Sent,
        profit_20_sent: !!trade.profit20Sent,
        profit_30_sent: !!trade.profit30Sent,

        updated_at: new Date().toISOString()
      })
      .eq('symbol', trade.symbol)
      .eq('type', trade.type)
      .eq('strike', Number(trade.strike))
      .eq('expiration', trade.expiration)
      .eq('status', 'OPEN');

    if (error) {
      console.error('Supabase Update Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Update Error:', err.message);
  }
}

async function closeTradeInSupabase(trade) {
  try {
    const { error } = await supabase
      .from('trade_updates')
      .update({
        current_price: trade.current,
        status: trade.status,
        pnl_percent: Number(pnlPercent(trade.entry, trade.current)),

        message_id: trade.messageId || null,
        contract_ticker: trade.contractTicker || null,

        profit_10_sent: !!trade.profit10Sent,
        profit_20_sent: !!trade.profit20Sent,
        profit_30_sent: !!trade.profit30Sent,

        updated_at: new Date().toISOString()
      })
      .eq('symbol', trade.symbol)
      .eq('type', trade.type)
      .eq('strike', Number(trade.strike))
      .eq('expiration', trade.expiration)
      .eq('status', 'OPEN');

    if (error) {
      console.error('Supabase Close Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Close Error:', err.message);
  }
}

function markTradeActive(trade) {
  activeTrades.set(tradeKey(trade.symbol), trade);
  saveTradeToSupabase(trade);
}

async function loadOpenTradesFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('trade_updates')
      .select('*')
      .eq('status', 'OPEN');

    if (error) {
      console.error('Load Open Trades Error:', error.message);
      return;
    }

    for (const row of data || []) {
      if (!row.contract_ticker) {
        console.log(`⚠️ صفقة مفتوحة بدون contract_ticker: ${row.symbol}`);
        continue;
      }

      const trade = {
        symbol: String(row.symbol || '').toUpperCase(),
        type: String(row.type || '').toUpperCase(),
        strike: row.strike,
        expiration: row.expiration,

        contractTicker: row.contract_ticker,
        messageId: row.message_id || null,

        entry: Number(row.entry_price),
        current: Number(row.current_price),

        target: Number(row.target_price),
        stockTarget2: null,
        stockTarget2Sent: false,
        target1Sent: false,

        stop: Number(row.stop_price),

        status: 'OPEN',
        lastUpdatePrice: Number(row.current_price),

        warnedStop: false,
        profit10Sent: !!row.profit_10_sent,
        profit20Sent: !!row.profit_20_sent,
        profit30Sent: !!row.profit_30_sent,

        volume: null,
        oi: null,
        delta: null,
        gamma: null,
        theta: null,
        iv: null,
        bid: null,
        ask: null,

        score: null,
        technicalBias: 'LOADED',
        technicalScore: 0,
        technicalReason: 'بانتظار تحديث التحليل من Massive',
        contractQuality: null,
        smartFlow: null,
        flowBias: 'LOADED',
        flowStrength: 'LOADED',
        dte: daysToExpiration(row.expiration),

        lastAnalysisAt: 0,
        lastTechStopCheckAt: 0,
        technicalStopReason: null
      };

      activeTrades.set(tradeKey(trade.symbol), trade);
    }

    console.log(`✅ Loaded ${activeTrades.size} open trades`);
  } catch (err) {
    console.error('Load Open Trades Error:', err.message);
  }
}

// =====================
// Finnhub Price API
// =====================

async function getStockPriceFromFinnhub(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();

  if (!symbol || !FINNHUB_API_KEY) {
    return null;
  }

  const cached = finnhubPriceCache.get(symbol);

  if (
    cached &&
    cached.price &&
    Date.now() - cached.time < FINNHUB_PRICE_CACHE_MS
  ) {
    return cached.price;
  }

  try {
    const url =
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Finnhub API Error');
    }

    const price = Number(data?.c);

    if (!price || price <= 0) {
      return null;
    }

    finnhubPriceCache.set(symbol, {
      price,
      time: Date.now()
    });

    return price;
  } catch (err) {
    console.error(`Finnhub Price Error ${symbol}:`, err.message);
    return null;
  }
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

  const finnhubPrice = await getStockPriceFromFinnhub(symbol);
  const price = finnhubPrice || Number(r.c);

  const change = r.o ? ((price - r.o) / r.o) * 100 : null;

  return {
    symbol,
    price,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    change
  };
}

async function getIntradayCandles(symbol) {
  const to = new Date();
  const from = new Date();

  from.setDate(from.getDate() - 3);

  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);

  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/range/5/minute/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=5000&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

async function getLatestStockPrice(symbol) {
  const finnhubPrice = await getStockPriceFromFinnhub(symbol);

  if (finnhubPrice) {
    return finnhubPrice;
  }

  try {
    const candles = await getIntradayCandles(symbol);

    if (!candles || !candles.length) return null;

    const last = candles[candles.length - 1];

    return Number(last.c);
  } catch (err) {
    console.error(`Latest Stock Price Error ${symbol}:`, err.message);
    return null;
  }
}

async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

async function getOptionSnapshot(symbol, contractTicker) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}/${contractTicker}?apiKey=${API_KEY}`;

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

    <line x1="160" y1="225" x2="640" y2="225"
      stroke="${color}" stroke-width="4" opacity="0.35" />

    <line x1="400" y1="80" x2="400" y2="370"
      stroke="${color}" stroke-width="4" opacity="0.18" />
  </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// =====================
// Technical Engine
// =====================

function ema(values, length) {
  if (!values.length) return null;

  const k = 2 / (length + 1);
  let emaValue = values[0];

  for (let i = 1; i < values.length; i++) {
    emaValue =
      values[i] * k +
      emaValue * (1 - k);
  }

  return emaValue;
}

function calculateVWAP(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical =
      (Number(c.h) + Number(c.l) + Number(c.c)) / 3;

    const v = Number(c.v || 0);

    pv += typical * v;
    volume += v;
  }

  if (!volume) return null;

  return pv / volume;
}

function candleStrength(candle) {
  if (!candle) return 0;

  const open = Number(candle.o);
  const close = Number(candle.c);
  const high = Number(candle.h);
  const low = Number(candle.l);

  const range = high - low;

  if (!range) return 0;

  return Math.abs(close - open) / range;
}

async function getTechnicalBias(symbol) {
  try {
    const candles = await getIntradayCandles(symbol);

    if (!candles || candles.length < 30) {
      return {
        side: 'NEUTRAL',
        score: 0,
        reason: 'بيانات الشموع غير كافية'
      };
    }

    const closes = candles.map(c => Number(c.c));
    const last = candles[candles.length - 1];
    const previous = candles.slice(-21, -1);

    const price = Number(last.c);

    const ema9 = ema(closes.slice(-30), 9);
    const ema21 = ema(closes.slice(-60), 21);
    const vwap = calculateVWAP(candles.slice(-78));

    const recentHigh = Math.max(...previous.map(c => Number(c.h)));
    const recentLow = Math.min(...previous.map(c => Number(c.l)));

    const strength = candleStrength(last);
    const volume = Number(last.v || 0);

    const avgVolume =
      previous.reduce((sum, c) => sum + Number(c.v || 0), 0) /
      previous.length;

    let callScore = 0;
    let putScore = 0;

    if (price > ema9) callScore += 15;
    if (price < ema9) putScore += 15;

    if (price > ema21) callScore += 20;
    if (price < ema21) putScore += 20;

    if (vwap && price > vwap) callScore += 20;
    if (vwap && price < vwap) putScore += 20;

    if (price > recentHigh) callScore += 20;
    if (price < recentLow) putScore += 20;

    if (volume > avgVolume * 1.2) {
      callScore += 10;
      putScore += 10;
    }

    if (strength >= 0.55) {
      if (price > Number(last.o)) {
        callScore += 15;
      } else {
        putScore += 15;
      }
    }

    if (
      callScore >= MIN_TECHNICAL_SCORE &&
      callScore > putScore + 15
    ) {
      return {
        side: 'CALL',
        score: callScore,
        reason: 'اتجاه فني صاعد'
      };
    }

    if (
      putScore >= MIN_TECHNICAL_SCORE &&
      putScore > callScore + 15
    ) {
      return {
        side: 'PUT',
        score: putScore,
        reason: 'اتجاه فني هابط'
      };
    }

    return {
      side: 'NEUTRAL',
      score: Math.max(callScore, putScore),
      reason: 'الاتجاه غير حاسم'
    };

  } catch (err) {
    console.error(`Technical Filter Error ${symbol}:`, err.message);

    return {
      side: 'NEUTRAL',
      score: 0,
      reason: 'تعذر حساب الفلتر الفني'
    };
  }
}

async function getTechnicalTarget2(symbol, type) {
  try {
    const candles = await getIntradayCandles(symbol);

    if (!candles || candles.length < 40) {
      return null;
    }

    const stockPrice = await getLatestStockPrice(symbol);
    const last = candles[candles.length - 1];
    const price = stockPrice || Number(last.c);

    const recent = candles.slice(-TECHNICAL_TARGET_LOOKBACK_BARS);

    const resistance = Math.max(...recent.map(c => Number(c.h)));
    const support = Math.min(...recent.map(c => Number(c.l)));

    if (
      type === 'CALL' &&
      resistance &&
      resistance > price * (1 + TECHNICAL_TARGET_BUFFER_PERCENT / 100)
    ) {
      return Number(resistance.toFixed(2));
    }

    if (
      type === 'PUT' &&
      support &&
      support < price * (1 - TECHNICAL_TARGET_BUFFER_PERCENT / 100)
    ) {
      return Number(support.toFixed(2));
    }

    return null;

  } catch (err) {
    console.error(`Technical Target2 Error ${symbol}:`, err.message);
    return null;
  }
}

// =====================
// Scoring Engine
// =====================

function stockMomentumSide(stock) {
  if (
    !stock ||
    stock.change === null ||
    stock.change === undefined
  ) {
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
function contractQualityScore(item, stock) {
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const mid = getMidPrice(item);
  const dist = distancePercent(getStrike(item), stock.price);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));
  const iv = Number(getIV(item) || 0);

  let score = 0;

  if (mid >= MIN_CONTRACT_PRICE && mid <= MAX_CONTRACT_PRICE) score += 15;

  if (delta >= 0.30 && delta <= 0.42) score += 20;
  else if (delta >= MIN_DELTA && delta <= MAX_DELTA) score += 12;

  if (gamma >= 0.08) score += 20;
  else if (gamma >= 0.04) score += 15;
  else if (gamma >= MIN_GAMMA) score += 8;

  if (spread <= 6) score += 15;
  else if (spread <= 10) score += 10;
  else if (spread <= MAX_SPREAD_PERCENT) score += 5;

  if (dist !== null) {
    if (dist <= 0.75) score += 15;
    else if (dist <= 1.5) score += 10;
    else if (dist <= MAX_DISTANCE_PERCENT) score += 5;
  }

  if (volume >= 3000) score += 10;
  else if (volume >= MIN_VOLUME) score += 6;

  if (oi >= 2000) score += 5;
  else if (oi >= 500) score += 3;

  if (dte >= 1 && dte <= 3) score += 8;
  else if (dte <= 7) score += 5;

  if (iv > 0 && iv <= 1.2) score += 5;

  return Math.min(score, 100);
}

function smartFlowScore(item, stock, flowBias = null) {
  const type = getContractType(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const dist = distancePercent(getStrike(item), stock.price);
  const spread = spreadPercent(item);

  let score = 0;

  if (volume > oi) score += 20;
  if (volume > oi * 2) score += 20;
  if (volume > oi * 4) score += 15;

  if (volume >= 5000) score += 15;
  else if (volume >= 2000) score += 10;
  else if (volume >= MIN_VOLUME) score += 5;

  if (gamma >= 0.08) score += 15;
  else if (gamma >= 0.04) score += 10;

  if (delta >= 0.30 && delta <= 0.45) score += 10;

  if (dist !== null && dist <= 1.5) score += 10;

  if (spread <= 10) score += 5;

  if (
    flowBias &&
    flowBias.side === type &&
    flowBias.side !== 'NEUTRAL'
  ) {
    score += flowBias.strength === 'STRONG' ? 20 : 10;
  }

  return Math.min(score, 100);
}

function flowItemScore(item, stock) {
  const type = getContractType(item);
  const strike = getStrike(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const dist = distancePercent(strike, stock.price);
  const mid = getMidPrice(item);

  if (!['CALL', 'PUT'].includes(type)) return 0;
  if (!strike || dist === null) return 0;
  if (dist > MAX_DISTANCE_PERCENT) return 0;
  if (!mid || mid <= 0) return 0;

  let score = 0;

  score += Math.min(volume / 100, 500);
  score += Math.min(oi / 150, 150);

  if (volume > oi) score += 250;
  if (volume > oi * 2) score += 200;
  if (volume > oi * 4) score += 150;

  if (gamma >= 0.08) score += 300;
  else if (gamma >= 0.04) score += 220;
  else if (gamma >= 0.02) score += 100;

  if (delta >= 0.25 && delta <= 0.45) score += 150;

  if (dist <= 0.5) score += 200;
  else if (dist <= 1) score += 150;
  else if (dist <= 2) score += 80;

  return score;
}

function getFlowBias(chain, stock) {
  let callScore = 0;
  let putScore = 0;

  for (const item of chain) {
    const type = getContractType(item);
    const score = flowItemScore(item, stock);

    if (type === 'CALL') callScore += score;
    if (type === 'PUT') putScore += score;
  }

  if (callScore > putScore * 1.30) {
    return {
      side: 'CALL',
      callScore,
      putScore,
      strength: 'STRONG'
    };
  }

  if (putScore > callScore * 1.30) {
    return {
      side: 'PUT',
      callScore,
      putScore,
      strength: 'STRONG'
    };
  }

  if (callScore > putScore * 1.10) {
    return {
      side: 'CALL',
      callScore,
      putScore,
      strength: 'MILD'
    };
  }

  if (putScore > callScore * 1.10) {
    return {
      side: 'PUT',
      callScore,
      putScore,
      strength: 'MILD'
    };
  }

  return {
    side: 'NEUTRAL',
    callScore,
    putScore,
    strength: 'NEUTRAL'
  };
}

function isCandidateContract(
  item,
  stock,
  flowBias = null,
  technicalBias = null
) {
  const type = getContractType(item);
  const strike = getStrike(item);
  const volume = getVolume(item);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const gamma = Number(getGamma(item) || 0);
  const mid = getMidPrice(item);
  const dist = distancePercent(strike, stock.price);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));
  const momentum = stockMomentumSide(stock);

  if (!['CALL', 'PUT'].includes(type)) return false;
  if (!strike || dist === null) return false;

  if (
    technicalBias &&
    technicalBias.side !== 'NEUTRAL' &&
    type !== technicalBias.side
  ) {
    return false;
  }

  if (technicalBias && technicalBias.side === 'NEUTRAL') return false;

  if (
    technicalBias &&
    technicalBias.score < MIN_TECHNICAL_SCORE
  ) {
    return false;
  }

  if (mid < MIN_CONTRACT_PRICE || mid > MAX_CONTRACT_PRICE) return false;
  if (volume < MIN_VOLUME) return false;
  if (delta < MIN_DELTA || delta > MAX_DELTA) return false;
  if (gamma < MIN_GAMMA) return false;
  if (dist > MAX_DISTANCE_PERCENT) return false;
  if (spread > MAX_SPREAD_PERCENT) return false;
  if (dte < 1 || dte > 10) return false;

  const quality = contractQualityScore(item, stock);
  if (quality < MIN_CONTRACT_QUALITY_SCORE) return false;

  const smartFlow = smartFlowScore(item, stock, flowBias);
  if (smartFlow < MIN_SMART_FLOW_SCORE) return false;

  if (
    flowBias &&
    flowBias.strength === 'STRONG' &&
    flowBias.side !== 'NEUTRAL' &&
    type !== flowBias.side
  ) {
    return false;
  }

  if (momentum !== 'NEUTRAL' && type !== momentum) {
    const flowSupportsContrarian =
      flowBias &&
      flowBias.side === type &&
      flowBias.strength === 'STRONG';

    const strongContrarian =
      volume > getOI(item) * 4 &&
      gamma >= 0.04 &&
      dist <= 1 &&
      technicalBias &&
      technicalBias.side === type;

    if (!flowSupportsContrarian && !strongContrarian) return false;
  }

  return true;
}
function contractScore(
  item,
  stock,
  flowBias = null,
  technicalBias = null
) {
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

  const quality = contractQualityScore(item, stock);
  const smartFlow = smartFlowScore(item, stock, flowBias);

  let score = 0;

  score += quality * 3;
  score += smartFlow * 3;

  if (technicalBias && technicalBias.side === type) {
    score += technicalBias.score * 3;
  }

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

  if (momentum !== 'NEUTRAL' && type === momentum) score += 250;

  if (
    flowBias &&
    flowBias.side === type &&
    flowBias.side !== 'NEUTRAL'
  ) {
    score += flowBias.strength === 'STRONG' ? 350 : 150;
  }

  if (
    flowBias &&
    flowBias.side !== 'NEUTRAL' &&
    flowBias.side !== type
  ) {
    score -= flowBias.strength === 'STRONG' ? 500 : 200;
  }

  return Math.round(score);
}

function selectBestContract(
  symbol,
  stock,
  chain,
  technicalBias = null
) {
  const flowBias = getFlowBias(chain, stock);

  const candidates = chain
    .filter(item =>
      isCandidateContract(
        item,
        stock,
        flowBias,
        technicalBias
      )
    )
    .map(item => ({
      item,
      score: contractScore(
        item,
        stock,
        flowBias,
        technicalBias
      )
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0];
  if (best.score < MIN_TOTAL_SCORE) return null;

  const item = best.item;

  const type = getContractType(item);
  const strike = getStrike(item);
  const expiration = getExpiration(item);
  const contractTicker = getContractTicker(item);
  const entry = getMidPrice(item);

  if (!contractTicker || !entry) return null;

  const tpMove = Math.max(
    entry * (TAKE_PROFIT_PERCENT / 100),
    MIN_TAKE_PROFIT_DOLLARS
  );

  const slMove = Math.max(
    entry * (STOP_LOSS_PERCENT / 100),
    MIN_STOP_LOSS_DOLLARS
  );

  const target = Number((entry + tpMove).toFixed(2));
  const stop = Number((entry - slMove).toFixed(2));

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

    stockTarget2: null,
    stockTarget2Sent: false,
    target1Sent: false,

    score: best.score,

    technicalBias: technicalBias?.side || 'NEUTRAL',
    technicalScore: technicalBias?.score || 0,
    technicalReason: technicalBias?.reason || 'غير متوفر',

    flowBias: flowBias.side,
    flowStrength: flowBias.strength,

    contractQuality: contractQualityScore(item, stock),
    smartFlow: smartFlowScore(item, stock, flowBias),

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

    profit10Sent: false,
    profit20Sent: false,
    profit30Sent: false,

    messageId: null,
    status: 'OPEN',
    lastAnalysisAt: Date.now(),
    lastTechStopCheckAt: 0,
    technicalStopReason: null
  };
}

// =====================
// Trade Messages
// =====================

function buildTradeCaption(trade, mode = 'entry') {
  const percent = pnlPercent(trade.entry, trade.current);

  const statusLine =
    trade.status === 'TARGET'
      ? '🎯 الحالة: تم تحقيق الهدف الفني الثاني'
      : trade.status === 'STOPPED'
        ? '❌ الحالة: تم الخروج بوقف فني'
        : '🟢 الحالة: الصفقة مفتوحة';

  const title =
    mode === 'update'
      ? '🚀 تحديث صفقة ST VIP'
      : '🚨 صفقة ST VIP';

  const target2Line =
    trade.stockTarget2
      ? `🎯 الهدف الثاني الفني على السهم: ${fmtPrice(trade.stockTarget2)}`
      : `🎯 الهدف الثاني الفني على السهم: غير متوفر حاليًا`;

  return `${title}

${statusLine}

📊 السهم: ${trade.symbol}
📈 النوع: ${trade.type} / ${sideArabic(trade.type)}
🎯 السترايك: ${trade.strike}
📅 الانتهاء: ${trade.expiration}

💰 الدخول: $${fmtPrice(trade.entry)}
💵 الحالي: $${fmtPrice(trade.current)}
📈 الربح/الخسارة: ${percent}%

🎯 الهدف الأول على العقد: $${fmtPrice(trade.target)}
${target2Line}
🛑 الوقف: وقف فني فقط

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

📊 الاتجاه الفني: ${trade.technicalBias || 'غير متوفر'}
🧠 سبب الفلترة: ${trade.technicalReason || 'غير متوفر'}
⭐ جودة العقد: ${fmt(trade.contractQuality)}
🔥 تدفق ذكي: ${fmt(trade.smartFlow)}

⭐ جودة الفلترة: ${fmt(trade.score)}

⏱ آخر تحديث:
${new Date().toLocaleString('ar-SA', {
    timeZone: 'Asia/Riyadh'
  })}

🔥 ST TRADE VIP`;
}
async function sendTradeEntry(trade) {
  const image = await createTradeImage(trade.type);
  const text = buildTradeCaption(trade, 'entry');

  const sent = await bot.sendPhoto(
    CHAT_ID,
    image,
    {
      caption: text,
      message_thread_id: THREAD_ID
    }
  );

  trade.messageId = sent.message_id;

  console.log('💾 messageId saved:', trade.messageId);

  return sent;
}

async function editTradeCaption(trade) {
  if (!trade.messageId) {
    console.log('❌ لا يوجد messageId لتعديل رسالة الصفقة');
    return false;
  }

  try {
    await bot.editMessageCaption(
      buildTradeCaption(trade, 'update'),
      {
        chat_id: CHAT_ID,
        message_id: Number(trade.messageId)
      }
    );

    return true;
  } catch (err) {
    console.error(
      `Edit Caption Error ${trade.symbol}:`,
      err.response?.body || err.message
    );

    return false;
  }
}

async function sendTradeUpdate(trade) {
  await updateTradeInSupabase(trade);

  const edited = await editTradeCaption(trade);

  const percent = pnlPercent(trade.entry, trade.current);
  
  const target2Line =
    trade.stockTarget2
      ? `🎯 الهدف الثاني الفني على السهم:\n${fmtPrice(trade.stockTarget2)}`
      : `🎯 الهدف الثاني الفني على السهم:\nغير متوفر حاليًا`;

  const text =
`🚀 تحديث الصفقة

📊 ${tradeTitle(trade)}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول:
$${fmtPrice(trade.entry)}

💵 الحالي:
$${fmtPrice(trade.current)}

📈 الربح الحالي:
${percent}%

━━━━━━━━━━━━━━

🎯 الهدف الأول على العقد:
$${fmtPrice(trade.target)}

${target2Line}

🛑 الوقف:
وقف فني فقط

🔥 ST TRADE VIP`;

  await bot.sendMessage(
    CHAT_ID,
    text,
    {
      message_thread_id: THREAD_ID
    }
  );
}

async function sendProfitUpdate(trade, level) {
  const percent = pnlPercent(trade.entry, trade.current);

  await updateTradeInSupabase(trade);
  await editTradeCaption(trade);

  const text =
`🚀 تحديث ربح الصفقة

📊 ${tradeTitle(trade)}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول:
$${fmtPrice(trade.entry)}

💵 الحالي:
$${fmtPrice(trade.current)}

📈 الربح الحالي:
${percent}%

🎯 وصل الربح:
+${level}%

━━━━━━━━━━━━━━

🎯 الهدف الأول على العقد:
$${fmtPrice(trade.target)}

🎯 الهدف الثاني الفني على السهم:
${trade.stockTarget2 ? fmtPrice(trade.stockTarget2) : 'غير متوفر حاليًا'}

🛑 الوقف:
وقف فني فقط

🔥 ST TRADE VIP`;

  await bot.sendMessage(
    CHAT_ID,
    text,
    {
      message_thread_id: THREAD_ID
    }
  );
}

async function sendTarget1Hit(trade) {
  trade.target1Sent = true;

  await updateTradeInSupabase(trade);
  await editTradeCaption(trade);

  const text =
`🎯 تم تحقيق الهدف الأول

📊 ${tradeTitle(trade)}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول:
$${fmtPrice(trade.entry)}

💵 سعر العقد الحالي:
$${fmtPrice(trade.current)}

📈 الربح الحالي:
${pnlPercent(trade.entry, trade.current)}%

━━━━━━━━━━━━━━

🎯 الهدف الثاني الفني على السهم:
${trade.stockTarget2 ? fmtPrice(trade.stockTarget2) : 'غير متوفر حاليًا'}

✅ الصفقة مستمرة للهدف الفني الثاني

🔥 ST TRADE VIP`;

  await bot.sendMessage(
    CHAT_ID,
    text,
    {
      message_thread_id: THREAD_ID
    }
  );
}

async function sendStopHit(trade) {
  trade.status = 'STOPPED';

  await closeTradeInSupabase(trade);
  await editTradeCaption(trade);

  const percent = pnlPercent(trade.entry, trade.current);

  const reason =
    trade.technicalStopReason ||
    'تحقق وقف فني';

  const text =
`❌ تم الخروج بوقف فني

📊 ${tradeTitle(trade)}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول:
$${fmtPrice(trade.entry)}

💵 الإغلاق:
$${fmtPrice(trade.current)}

📉 النتيجة:
${percent}%

━━━━━━━━━━━━━━

🧠 سبب الخروج:
${reason}`;

  await bot.sendMessage(
    CHAT_ID,
    text,
    {
      message_thread_id: THREAD_ID
    }
  );
}

async function sendTargetHit(trade) {
  trade.status = 'TARGET';

  await closeTradeInSupabase(trade);
  await editTradeCaption(trade);

  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`🎯 تم تحقيق الهدف الفني الثاني

📊 ${tradeTitle(trade)}

📅 الانتهاء:
${trade.expiration}

━━━━━━━━━━━━━━

💰 الدخول:
$${fmtPrice(trade.entry)}

💵 سعر العقد الحالي:
$${fmtPrice(trade.current)}

📈 الربح النهائي:
${percent}%

🎯 هدف السهم الفني:
${trade.stockTarget2 ? fmtPrice(trade.stockTarget2) : 'غير متوفر'}

🔥 ST TRADE VIP`;

  await bot.sendMessage(
    CHAT_ID,
    text,
    {
      message_thread_id: THREAD_ID
    }
  );
}

// =====================
// Trade Updates
// =====================

function normalizeOptionSnapshot(snapshot) {
  return snapshot?.results || snapshot?.ticker || snapshot;
}

function applySnapshotToTrade(trade, item) {
  if (!item) return;

  const bid = getBid(item);
  const ask = getAsk(item);
  const volume = getVolume(item);
  const oi = getOI(item);

  if (bid > 0) trade.bid = bid;
  if (ask > 0) trade.ask = ask;

  if (volume > 0) trade.volume = volume;
  if (oi > 0) trade.oi = oi;

  const delta = getDelta(item);
  const gamma = getGamma(item);
  const theta = getTheta(item);
  const iv = getIV(item);

  if (delta !== undefined && delta !== null) trade.delta = delta;
  if (gamma !== undefined && gamma !== null) trade.gamma = gamma;
  if (theta !== undefined && theta !== null) trade.theta = theta;
  if (iv !== undefined && iv !== null) trade.iv = iv;

  trade.dte = daysToExpiration(trade.expiration);
}

function findSameContract(chain, trade, fallbackItem) {
  const wantedTicker = String(trade.contractTicker || '').toUpperCase();
  const wantedType = String(trade.type || '').toUpperCase();
  const wantedStrike = Number(trade.strike);
  const wantedExp = String(trade.expiration || '');

  const found = (chain || []).find(item => {
    const ticker = String(getContractTicker(item) || '').toUpperCase();
    const type = getContractType(item);
    const strike = Number(getStrike(item));
    const exp = String(getExpiration(item) || '');

    return (
      ticker === wantedTicker ||
      (
        type === wantedType &&
        strike === wantedStrike &&
        exp === wantedExp
      )
    );
  });

  return found || fallbackItem;
}
async function enrichTradeAnalysis(trade, snapshotItem) {
  const now = Date.now();

  const mustRefresh =
    !trade.lastAnalysisAt ||
    trade.technicalBias === 'LOADED' ||
    trade.contractQuality === null ||
    trade.smartFlow === null ||
    trade.score === null ||
    now - trade.lastAnalysisAt >= ANALYSIS_REFRESH_MS;

  if (!mustRefresh) return;

  try {
    const stock = await getStockSnapshot(trade.symbol);
    if (!stock) return;

    const technicalBias = await getTechnicalBias(trade.symbol);
    const chain = await getOptionsChain(trade.symbol);
    const flowBias = getFlowBias(chain, stock);

    const item = findSameContract(chain, trade, snapshotItem);

    if (!trade.stockTarget2) {
      trade.stockTarget2 = await getTechnicalTarget2(
        trade.symbol,
        trade.type
      );
    }

    if (!item) {
      trade.technicalBias = technicalBias?.side || trade.technicalBias || 'غير متوفر';
      trade.technicalScore = technicalBias?.score || 0;
      trade.technicalReason = technicalBias?.reason || 'تم تحديث السعر فقط';
      trade.lastAnalysisAt = now;
      return;
    }

    applySnapshotToTrade(trade, item);

    trade.technicalBias = technicalBias?.side || 'NEUTRAL';
    trade.technicalScore = technicalBias?.score || 0;
    trade.technicalReason = technicalBias?.reason || 'غير متوفر';

    trade.flowBias = flowBias.side;
    trade.flowStrength = flowBias.strength;

    trade.contractQuality = contractQualityScore(item, stock);
    trade.smartFlow = smartFlowScore(item, stock, flowBias);
    trade.score = contractScore(item, stock, flowBias, technicalBias);

    trade.lastAnalysisAt = now;

    console.log(
      `✅ تحليل محدث ${trade.symbol}: Volume=${trade.volume} OI=${trade.oi} Delta=${trade.delta} IV=${trade.iv}`
    );
  } catch (err) {
    console.error(`Enrich Analysis Error ${trade.symbol}:`, err.message);
  }
}

function getRecentSupportResistance(candles) {
  const recent = candles.slice(
    -STOP_LOOKBACK_BARS - 2,
    -2
  );

  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support: Math.min(...recent.map(c => Number(c.l))),
    resistance: Math.max(...recent.map(c => Number(c.h)))
  };
}

async function shouldTechnicalStop(trade) {
  const now = Date.now();

  if (
    trade.lastTechStopCheckAt &&
    now - trade.lastTechStopCheckAt < TECHNICAL_STOP_CHECK_MS
  ) {
    return false;
  }

  trade.lastTechStopCheckAt = now;

  const candles = await getIntradayCandles(trade.symbol);

  if (!candles || candles.length < 40) {
    return false;
  }

  const closes = candles.map(c => Number(c.c));
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const lastClose = Number(last.c);
  const prevClose = Number(prev.c);

  const ema9 = ema(closes.slice(-30), 9);
  const vwap = calculateVWAP(candles.slice(-78));

  const { support, resistance } =
    getRecentSupportResistance(candles);

  if (!ema9 || !vwap) {
    return false;
  }

  const supportBreak =
    support &&
    lastClose < support * (1 - STOP_BREAK_BUFFER_PERCENT / 100);

  const resistanceBreak =
    resistance &&
    lastClose > resistance * (1 + STOP_BREAK_BUFFER_PERCENT / 100);

  if (trade.type === 'CALL') {
    const twoClosesBelowVWAP =
      lastClose < vwap &&
      prevClose < vwap;

    const belowEMA9 =
      lastClose < ema9;

    if (
      twoClosesBelowVWAP &&
      belowEMA9 &&
      supportBreak
    ) {
      trade.technicalStopReason =
        `إغلاق شمعتين تحت VWAP + السعر تحت EMA9 + كسر دعم ${fmtPrice(support)}`;

      return true;
    }
  }

  if (trade.type === 'PUT') {
    const twoClosesAboveVWAP =
      lastClose > vwap &&
      prevClose > vwap;

    const aboveEMA9 =
      lastClose > ema9;

    if (
      twoClosesAboveVWAP &&
      aboveEMA9 &&
      resistanceBreak
    ) {
      trade.technicalStopReason =
        `إغلاق شمعتين فوق VWAP + السعر فوق EMA9 + اختراق مقاومة ${fmtPrice(resistance)}`;

      return true;
    }
  }

  return false;
}

async function refreshTradeData(trade) {
  const snapshot = await getOptionSnapshot(
    trade.symbol,
    trade.contractTicker
  );

  if (!snapshot) return null;

  const data = normalizeOptionSnapshot(snapshot);

  applySnapshotToTrade(trade, data);

  const bid = Number(data?.last_quote?.bid || 0);
  const ask = Number(data?.last_quote?.ask || 0);

  const last = Number(
    data?.last_trade?.price ||
    data?.day?.close ||
    0
  );

  let current = 0;

  if (bid > 0 && ask > 0) {
    current = (bid + ask) / 2;
  } else if (last > 0) {
    current = last;
  }

  if (!current || current <= 0) {
    console.log(`⚠️ لم يتم تحديث سعر العقد: ${trade.contractTicker}`);
    return null;
  }

  await enrichTradeAnalysis(trade, data);

  console.log(
    `🔄 تحديث ${trade.symbol} ${trade.type} ${trade.strike}: ${trade.current} → ${current.toFixed(2)}`
  );

  return Number(current.toFixed(2));
}

async function updateActiveTrades() {
  for (const [symbol, trade] of activeTrades.entries()) {
    try {
      if (trade.status !== 'OPEN') continue;

      const current = await refreshTradeData(trade);
      if (!current) continue;

      trade.current = current;

      if (!trade.stockTarget2) {
        trade.stockTarget2 = await getTechnicalTarget2(
          trade.symbol,
          trade.type
        );
      }

      const stockPrice = await getLatestStockPrice(trade.symbol);

      const profitNow = Number(pnlPercent(trade.entry, trade.current));

      if (profitNow >= 10 && !trade.profit10Sent) {
        trade.profit10Sent = true;
        await sendProfitUpdate(trade, 10);
      }

      if (profitNow >= 20 && !trade.profit20Sent) {
        trade.profit20Sent = true;
        await sendProfitUpdate(trade, 20);
      }

      if (profitNow >= 30 && !trade.profit30Sent) {
        trade.profit30Sent = true;
        await sendProfitUpdate(trade, 30);
      }

      await updateTradeInSupabase(trade);

      const technicalStop = await shouldTechnicalStop(trade);

      if (technicalStop) {
        await sendStopHit(trade);
        removeTrade(symbol);
        continue;
      }

      if (trade.current >= trade.target && !trade.target1Sent) {
        await sendTarget1Hit(trade);
      }

      if (
        trade.stockTarget2 &&
        stockPrice &&
        (
          (trade.type === 'CALL' && stockPrice >= trade.stockTarget2) ||
          (trade.type === 'PUT' && stockPrice <= trade.stockTarget2)
        )
      ) {
        await sendTargetHit(trade);
        removeTrade(symbol);
        continue;
      }

      if (
        Math.abs(trade.current - trade.lastUpdatePrice) >= UPDATE_STEP
      ) {
        await sendTradeUpdate(trade);
        trade.lastUpdatePrice = trade.current;
      }

    } catch (err) {
      console.error(`Update Error ${symbol}:`, err.message);
    }
  }
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

  if (force) {
    const marketOpen = await isMarketOpenNow();

    if (!marketOpen) {
      return {
        ok: false,
        message: '⛔ السوق مغلق حالياً.'
      };
    }
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

  const technicalBias = await getTechnicalBias(symbol);

  if (!technicalBias || technicalBias.side === 'NEUTRAL') {
    return {
      ok: false,
      message: `⚠️ ${symbol}: لا يوجد اتجاه فني واضح.`
    };
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return {
      ok: false,
      message: `⚠️ لا توجد عقود متاحة على ${symbol}.`
    };
  }

  const trade = selectBestContract(
    symbol,
    stock,
    chain,
    technicalBias
  );

  if (!trade) {
    return {
      ok: false,
      message: `⚠️ لا توجد صفقة قوية مطابقة للشروط على ${symbol}.`
    };
  }

  trade.stockTarget2 = await getTechnicalTarget2(
    symbol,
    trade.type
  );

  if (!force && wasSentToday(trade)) {
    return {
      ok: false,
      message: `⚠️ تم إرسال نفس صفقة ${symbol} اليوم سابقًا.`
    };
  }

  await sendTradeEntry(trade);

  markTradeActive(trade);
  markSentToday(trade);

  return {
    ok: true,
    message: `✅ تم إرسال صفقة ${symbol}.`
  };
}

async function scanForTrades() {
  resetDailyMemoryIfNeeded();

  if (botPaused) {
    console.log('⏸ Bot paused.');
    return;
  }

  const marketOpen = await isMarketOpenNow();

  if (!marketOpen) {
    console.log('⛔ Market closed.');
    return;
  }

  if (!SYMBOLS.length) {
    console.log('⚠️ No symbols configured.');
    return;
  }

  const symbolsToScan = [];

  for (let i = 0; i < SYMBOLS_PER_SCAN; i++) {
    const symbol = SYMBOLS[scanIndex % SYMBOLS.length];
    scanIndex++;
    symbolsToScan.push(symbol);
  }

  console.log(`🔎 Auto scan symbols: ${symbolsToScan.join(', ')}`);

  for (const symbol of symbolsToScan) {
    try {
      if (blockedSymbols.has(symbol)) {
        console.log(`⛔ ${symbol} blocked.`);
        continue;
      }

      if (!isAllowedSignalTime(symbol)) {
        console.log(`⛔ ${symbol} outside signal time.`);
        continue;
      }

      if (alreadyHasActiveTrade(symbol)) {
        console.log(`⚠️ ${symbol} already has active trade.`);
        continue;
      }

      const result = await scanSingleSymbol(symbol, false);

      console.log(`${symbol}: ${result.message}`);

    } catch (err) {
      console.error(`Scan Error ${symbol}:`, err.message);
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

bot.onText(/\/id/, async (msg) => {
  await sendToSameTopic(
    msg,
`🆔 بياناتك:

from.id:
${msg.from?.id}

chat.id:
${msg.chat?.id}

thread.id:
${msg.message_thread_id || 'لا يوجد'}`
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

  const openTrades =
    [...activeTrades.values()]
      .map(
        t =>
          `• ${t.symbol} ${t.type} ${t.strike} | دخول $${fmtPrice(t.entry)} | حالي $${fmtPrice(t.current)} | عقد ${t.contractTicker || 'غير متوفر'} | هدف فني ${t.stockTarget2 ? fmtPrice(t.stockTarget2) : 'غير متوفر'}`
      )
      .join('\n');

  const nextSymbols = [];

  for (let i = 0; i < SYMBOLS_PER_SCAN; i++) {
    if (SYMBOLS.length) {
      nextSymbols.push(SYMBOLS[(scanIndex + i) % SYMBOLS.length]);
    }
  }

  await sendToSameTopic(
    msg,
`📊 حالة بوت الصفقات

الحالة:
${botPaused ? '⏸ متوقف' : '▶️ يعمل'}

نظام الفحص:
${SYMBOLS_PER_SCAN} أسهم كل دورة

الأسهم القادمة للفحص:
${nextSymbols.length ? nextSymbols.join(', ') : 'غير متوفر'}

قائمة الأسهم:
${SYMBOLS.join(', ')}

عدد الصفقات المفتوحة:
${activeTrades.size}

الأسهم الموقوفة:
${
  blockedSymbols.size
    ? [...blockedSymbols].join(', ')
    : 'لا يوجد'
}

الصفقات المفتوحة:
${openTrades || 'لا توجد صفقات'}`
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
    `⛔ تم إيقاف ${symbol}`
  );
});

bot.onText(/\/unblock\s+([A-Za-z]{1,10})/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  blockedSymbols.delete(symbol);

  await sendToSameTopic(
    msg,
    `✅ تم تفعيل ${symbol}`
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
      `لا توجد صفقة على ${symbol}`
    );

    return;
  }

  const trade = activeTrades.get(symbol);

  trade.status = 'STOPPED';
  trade.technicalStopReason = 'تم إغلاق الصفقة يدويًا من المالك';

  await closeTradeInSupabase(trade);

  removeTrade(symbol);

  await sendToSameTopic(
    msg,
    `🛑 تم حذف صفقة ${symbol}`
  );
});

bot.onText(/\/scan/, async (msg) => {
  if (!isAdmin(msg)) return;

  const nextSymbols = [];

  for (let i = 0; i < SYMBOLS_PER_SCAN; i++) {
    if (SYMBOLS.length) {
      nextSymbols.push(SYMBOLS[(scanIndex + i) % SYMBOLS.length]);
    }
  }

  await sendToSameTopic(
    msg,
    `🔎 جاري فحص ${SYMBOLS_PER_SCAN} أسهم: ${nextSymbols.join(', ')}`
  );

  await scanForTrades();

  await sendToSameTopic(
    msg,
    '✅ انتهى الفحص.'
  );
});

bot.onText(/\/update/, async (msg) => {
  if (!isAdmin(msg)) return;

  await sendToSameTopic(
    msg,
    '🔄 جاري تحديث الصفقات المفتوحة...'
  );

  await updateActiveTrades();

  await sendToSameTopic(
    msg,
    '✅ انتهى تحديث الصفقات.'
  );
});

// =====================
// Start Loops
// =====================

(async () => {
  await loadOpenTradesFromSupabase();
  await updateActiveTrades();
  await scanForTrades();

  setInterval(
    scanForTrades,
    SCAN_INTERVAL_MS
  );

  setInterval(
    updateActiveTrades,
    UPDATE_INTERVAL_MS
  );

  console.log('🚀 ST Real Options Signals Bot Started');
})();
