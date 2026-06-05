require('dotenv').config();

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SYMBOLS = String(process.env.DASHBOARD_SYMBOLS || 'TSLA,NVDA,AMZN,SPY,QQQ')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const UPDATE_MINUTES = Number(process.env.DASHBOARD_UPDATE_MINUTES || 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function round(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(d));
}

async function getFinnhubPrice(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return round(data?.c, 2);
}

function buildDemoLevels(price) {
  const step = price >= 300 ? 2.5 : price >= 100 ? 1 : 0.5;

  return {
    gamma_resistance_1: round(price + step),
    gamma_resistance_2: round(price + step * 2),
    gamma_resistance_3: round(price + step * 3),

    gamma_support_1: round(price - step),
    gamma_support_2: round(price - step * 2),
    gamma_support_3: round(price - step * 3),

    buy_liquidity_1: round(price + step),
    buy_liquidity_2: round(price + step * 2),
    buy_liquidity_3: round(price + step * 3),

    sell_liquidity_1: round(price - step),
    sell_liquidity_2: round(price - step * 2),
    sell_liquidity_3: round(price - step * 3)
  };
}

async function syncSymbol(symbol) {
  const price = await getFinnhubPrice(symbol);
  if (!price) {
    console.log(`NO PRICE: ${symbol}`);
    return;
  }

  const levels = buildDemoLevels(price);

  const row = {
    symbol,
    price,

    ...levels,

    gamma_flip: round(price * 0.95),
    gex: null,
    dex: null,

    call_flow: null,
    put_flow: null,

    confidence_score: null,

    market_gamma: 'غير متاح',
    market_direction: 'غير متاح',
    recommendation: 'انتظار',

    target_1: levels.gamma_resistance_1,
    target_2: levels.gamma_resistance_2,
    target_3: levels.gamma_resistance_3,
    stop_loss: levels.gamma_support_2,

    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('market_dashboard')
    .upsert(row, { onConflict: 'symbol' });

  if (error) {
    console.error(`SUPABASE ERROR ${symbol}:`, error.message);
    return;
  }

  console.log(`UPDATED ${symbol}: ${price}`);
}

async function run() {
  console.log('Dashboard Sync Started');
  console.log('Symbols:', SYMBOLS.join(', '));

  for (const symbol of SYMBOLS) {
    try {
      await syncSymbol(symbol);
    } catch (err) {
      console.error(`ERROR ${symbol}:`, err.message);
    }
  }

  console.log(`Next update after ${UPDATE_MINUTES} minutes`);
}

run();
setInterval(run, UPDATE_MINUTES * 60 * 1000);
