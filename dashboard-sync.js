require('dotenv').config();

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SYMBOLS = String(process.env.DASHBOARD_SYMBOLS || 'TSLA,NVDA,AMZN,SPY,QQQ,META,AAPL')
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const UPDATE_MINUTES = Number(process.env.DASHBOARD_UPDATE_MINUTES || 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(d));
}

function distancePct(price, strike) {
  if (!price || !strike) return 999;
  return Math.abs((Number(strike) - Number(price)) / Number(price)) * 100;
}

async function getPrice(symbol) {
  const { data } = await axios.get('https://finnhub.io/api/v1/quote', {
    params: {
      symbol,
      token: FINNHUB_API_KEY
    },
    timeout: 15000
  });

  const price = num(data?.c, 0);
  return price > 0 ? round(price, 2) : null;
}

async function getOptionsSnapshot(symbol) {
  let url = `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${MASSIVE_API_KEY}`;
  let results = [];
  let page = 0;

  while (url && page < 4) {
    const { data } = await axios.get(url, { timeout: 25000 });

    results = results.concat(data.results || []);

    if (data.next_url) {
      url = data.next_url.includes('apiKey=')
        ? data.next_url
        : `${data.next_url}&apiKey=${MASSIVE_API_KEY}`;
    } else {
      url = null;
    }

    page++;
  }

  return results;
}

function getType(item) {
  return String(item?.details?.contract_type || '').toLowerCase();
}

function getStrike(item) {
  return num(item?.details?.strike_price, null);
}

function getOI(item) {
  return num(item?.open_interest, 0);
}

function getVolume(item) {
  return num(item?.day?.volume ?? item?.volume, 0);
}

function getGamma(item) {
  return num(item?.greeks?.gamma, 0);
}

function getDelta(item) {
  return num(item?.greeks?.delta, 0);
}

function analyzeOptions(chain, price) {
  const byStrike = {};

  let totalGex = 0;
  let totalDex = 0;
  let callVolume = 0;
  let putVolume = 0;

  for (const item of chain) {
    const type = getType(item);
    const strike = getStrike(item);
    const oi = getOI(item);
    const volume = getVolume(item);
    const gamma = getGamma(item);
    const delta = getDelta(item);

    if (!strike || !['call', 'put'].includes(type)) continue;

    if (!byStrike[strike]) {
      byStrike[strike] = {
        strike,
        netGex: 0,
        callLiquidity: 0,
        putLiquidity: 0
      };
    }

    const rawGex = gamma * oi * 100;
    const signedGex = type === 'put' ? -rawGex : rawGex;

    byStrike[strike].netGex += signedGex;
    totalGex += signedGex;

    totalDex += delta * oi * 100;

    const liquidityScore = volume + oi;

    if (type === 'call') {
      callVolume += volume;
      byStrike[strike].callLiquidity += liquidityScore;
    }

    if (type === 'put') {
      putVolume += volume;
      byStrike[strike].putLiquidity += liquidityScore;
    }
  }

  const rows = Object.values(byStrike)
    .filter(r => distancePct(price, r.strike) <= 15)
    .sort((a, b) => a.strike - b.strike);

  const maxPower = Math.max(...rows.map(r => Math.abs(r.netGex)), 1);
  const minPower = maxPower * 0.03;

  const gammaResistances = rows
    .filter(r => r.strike >= price && Math.abs(r.netGex) >= minPower)
    .sort((a, b) => a.strike - b.strike)
    .slice(0, 3);

  const gammaSupports = rows
    .filter(r => r.strike <= price && Math.abs(r.netGex) >= minPower)
    .sort((a, b) => b.strike - a.strike)
    .slice(0, 3);

  const buyLiquidity = rows
    .filter(r => r.strike >= price && r.callLiquidity > 0)
    .sort((a, b) => b.callLiquidity - a.callLiquidity)
    .slice(0, 3);

  const sellLiquidity = rows
    .filter(r => r.strike <= price && r.putLiquidity > 0)
    .sort((a, b) => b.putLiquidity - a.putLiquidity)
    .slice(0, 3);

  const gammaFlipRow = rows.reduce((best, row) => {
    if (!best) return row;
    return Math.abs(row.netGex) < Math.abs(best.netGex) ? row : best;
  }, null);

  const totalFlow = callVolume + putVolume;

  const callFlow = totalFlow > 0
    ? (callVolume / totalFlow) * 100
    : null;

  const putFlow = totalFlow > 0
    ? (putVolume / totalFlow) * 100
    : null;

  const marketGamma = totalGex >= 0
    ? 'إيجابية'
    : 'سلبية';

  let marketDirection = 'محايد';

  if (totalDex > 0 && callFlow !== null && callFlow > putFlow) {
    marketDirection = 'صاعد';
  }

  if (totalDex < 0 && putFlow !== null && putFlow > callFlow) {
    marketDirection = 'هابط';
  }

  let confidenceScore = 0;

  if (Math.abs(totalGex) > 0) confidenceScore += 2;
  if (Math.abs(totalDex) > 0) confidenceScore += 2;

  if (callFlow !== null && putFlow !== null) {
    const flowDiff = Math.abs(callFlow - putFlow);

    if (flowDiff >= 40) confidenceScore += 3;
    else if (flowDiff >= 25) confidenceScore += 2;
    else if (flowDiff >= 10) confidenceScore += 1;
  }

  if (marketDirection !== 'محايد') confidenceScore += 2;
  if (gammaResistances.length && gammaSupports.length) confidenceScore += 1;

  confidenceScore = Math.min(10, confidenceScore);

  return {
    gammaSupports,
    gammaResistances,
    buyLiquidity,
    sellLiquidity,
    gammaFlip: gammaFlipRow?.strike || null,
    gex: totalGex,
    dex: totalDex,
    callFlow,
    putFlow,
    confidenceScore,
    marketGamma,
    marketDirection
  };
}

function pickStrike(arr, i) {
  return arr[i]?.strike ? round(arr[i].strike, 2) : null;
}

async function syncSymbol(symbol) {
  const price = await getPrice(symbol);

  if (!price) {
    console.log(`NO PRICE: ${symbol}`);
    return;
  }

  const chain = await getOptionsSnapshot(symbol);

  if (!chain.length) {
    console.log(`NO OPTIONS DATA: ${symbol}`);
    return;
  }

  const a = analyzeOptions(chain, price);

  const row = {
    symbol,
    price,

    gamma_support_1: pickStrike(a.gammaSupports, 0),
    gamma_support_2: pickStrike(a.gammaSupports, 1),
    gamma_support_3: pickStrike(a.gammaSupports, 2),

    gamma_resistance_1: pickStrike(a.gammaResistances, 0),
    gamma_resistance_2: pickStrike(a.gammaResistances, 1),
    gamma_resistance_3: pickStrike(a.gammaResistances, 2),

    buy_liquidity_1: pickStrike(a.buyLiquidity, 0),
    buy_liquidity_2: pickStrike(a.buyLiquidity, 1),
    buy_liquidity_3: pickStrike(a.buyLiquidity, 2),

    sell_liquidity_1: pickStrike(a.sellLiquidity, 0),
    sell_liquidity_2: pickStrike(a.sellLiquidity, 1),
    sell_liquidity_3: pickStrike(a.sellLiquidity, 2),

    gamma_flip: round(a.gammaFlip, 2),

    gex: round(a.gex, 2),
    dex: round(a.dex, 2),

    call_flow: round(a.callFlow, 2),
    put_flow: round(a.putFlow, 2),

    confidence_score: round(a.confidenceScore, 2),

    market_gamma: a.marketGamma,
    market_direction: a.marketDirection,

    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('market_dashboard')
    .upsert(row, { onConflict: 'symbol' });

  if (error) {
    console.error(`SUPABASE ERROR ${symbol}:`, error.message);
    return;
  }

  console.log(
    `UPDATED ${symbol} | price ${price} | GEX ${round(a.gex, 2)} | DEX ${round(a.dex, 2)} | Flow ${round(a.callFlow, 2)}/${round(a.putFlow, 2)}`
  );
}

async function run() {
  console.log('Dashboard Sync Started');
  console.log('Symbols:', SYMBOLS.join(', '));

  for (const symbol of SYMBOLS) {
    try {
      await syncSymbol(symbol);
    } catch (err) {
      console.error(`ERROR ${symbol}:`, err.response?.data || err.message);
    }
  }

  console.log(`Next update after ${UPDATE_MINUTES} minutes`);
}

run();
setInterval(run, UPDATE_MINUTES * 60 * 1000);
