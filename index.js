const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');
const fs = require('fs');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const SIGNALS_CHAT_ID = process.env.SIGNALS_CHAT_ID;
const SIGNALS_THREAD_ID = Number(process.env.SIGNALS_THREAD_ID);

const symbols = [
  'TSLA',
  'NVDA',
  'AMZN',
  'SPY',
  'QQQ',
  'META'
];

const activeSignals = new Map();
const sentSignals = new Set();

function pnlPercent(entry, current) {
  return (((current - entry) / entry) * 100).toFixed(2);
}

async function createCard(signal, status = 'ENTRY') {
  const isCall = signal.type === 'CALL';

  const mainColor =
    status === 'STOP'
      ? '#ff1744'
      : isCall
      ? '#00e676'
      : '#ff1744';

  const statusTitle =
    status === 'ENTRY'
      ? 'NEW SIGNAL'
      : status === 'UPDATE'
      ? 'TRADE UPDATE'
      : status === 'TARGET'
      ? 'TARGET HIT'
      : status === 'NEAR_STOP'
      ? 'NEAR STOP'
      : 'STOP LOSS';

  const svg = `
<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">

  <rect width="1080" height="1080" fill="#07070b"/>

  <rect
    x="45"
    y="45"
    width="990"
    height="990"
    rx="52"
    fill="#11111a"
    stroke="${mainColor}"
    stroke-width="9"
  />

  <circle
    cx="540"
    cy="250"
    r="120"
    fill="${mainColor}"
    opacity="0.12"
  />

  <text
    x="540"
    y="145"
    text-anchor="middle"
    fill="#ffffff"
    font-size="62"
    font-family="Arial"
    font-weight="bold"
  >
    ST TRADE VIP
  </text>

  <text
    x="540"
    y="225"
    text-anchor="middle"
    fill="${mainColor}"
    font-size="46"
    font-family="Arial"
    font-weight="bold"
  >
    ${statusTitle}
  </text>

  <text
    x="540"
    y="430"
    text-anchor="middle"
    fill="#ffffff"
    font-size="160"
    font-family="Arial"
    font-weight="bold"
  >
    ${signal.symbol}
  </text>

  <text
    x="540"
    y="575"
    text-anchor="middle"
    fill="${mainColor}"
    font-size="115"
    font-family="Arial"
    font-weight="bold"
  >
    ${signal.type}
  </text>

  <text
    x="540"
    y="760"
    text-anchor="middle"
    fill="#ffffff"
    font-size="145"
    font-family="Arial"
    font-weight="bold"
  >
    $${signal.currentPrice.toFixed(2)}
  </text>

  <text
    x="540"
    y="910"
    text-anchor="middle"
    fill="#8f8f9a"
    font-size="42"
    font-family="Arial"
    font-weight="bold"
  >
    OPTIONS SIGNAL CARD
  </text>

</svg>
`;

  const file = `signal-${Date.now()}.png`;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(file);

  return file;
}

function arabicStatus(status) {
  if (status === 'ENTRY') return 'صفقة جديدة';
  if (status === 'UPDATE') return 'تحديث الصفقة';
  if (status === 'TARGET') return 'تحقق الهدف';
  if (status === 'NEAR_STOP') return 'تنبيه قريب من الوقف';
  if (status === 'STOP') return 'ضرب وقف الخسارة';
  return 'تحديث';
}

async function sendPhotoCard(signal, status) {
  const file = await createCard(signal, status);

  const pnl = pnlPercent(
    signal.entry,
    signal.currentPrice
  );

  const caption =
`🚨 ${arabicStatus(status)}

📊 السهم:
${signal.symbol}

📈 نوع العقد:
${signal.type}

🎯 السترايك:
${signal.strike}

💰 سعر الدخول:
$${signal.entry.toFixed(2)}

📍 السعر الحالي:
$${signal.currentPrice.toFixed(2)}

${
  Number(pnl) >= 0
    ? '✅ نسبة الربح'
    : '❌ نسبة الخسارة'
}:
${pnl}%

🛡 وقف الخسارة:
$${signal.stopLoss.toFixed(2)}

🎯 الهدف:
$${signal.target.toFixed(2)}

🔥 ST TRADE VIP`;

  await bot.sendPhoto(
    SIGNALS_CHAT_ID,
    file,
    {
      message_thread_id: SIGNALS_THREAD_ID,
      caption
    }
  );

  fs.unlinkSync(file);
}

function generateFakeSignal(symbol) {
  const type =
    Math.random() > 0.5
      ? 'CALL'
      : 'PUT';

  const entry = Number(
    (Math.random() * 1 + 1.5).toFixed(2)
  );

  return {
    symbol,
    type,
    strike: Math.floor(
      Math.random() * 300 + 100
    ),
    entry,
    currentPrice: entry,
    stopLoss: Number(
      (entry - 0.30).toFixed(2)
    ),
    nextUpdate: Number(
      (entry + 0.10).toFixed(2)
    ),
    target: Number(
      (entry + 0.50).toFixed(2)
    ),
    status: 'OPEN'
  };
}

async function sendSignal(signal) {
  const key = `${signal.symbol}-${signal.type}-${signal.strike}`;

  if (sentSignals.has(key)) {
    return;
  }

  sentSignals.add(key);
  activeSignals.set(key, signal);

  await sendPhotoCard(signal, 'ENTRY');
}

async function updateSignals() {
  for (const [key, signal] of activeSignals) {
    if (signal.status !== 'OPEN') {
      continue;
    }

    const movement = Math.random() * 0.20 - 0.05;

    signal.currentPrice = Number(
      (signal.currentPrice + movement).toFixed(2)
    );

    if (
      signal.currentPrice <= signal.stopLoss + 0.05 &&
      signal.currentPrice > signal.stopLoss
    ) {
      await sendPhotoCard(signal, 'NEAR_STOP');
    }

    if (signal.currentPrice <= signal.stopLoss) {
      signal.status = 'STOPPED';
      await sendPhotoCard(signal, 'STOP');
      continue;
    }

    if (signal.currentPrice >= signal.target) {
      signal.status = 'TARGET';
      await sendPhotoCard(signal, 'TARGET');
      continue;
    }

    if (signal.currentPrice >= signal.nextUpdate) {
      await sendPhotoCard(signal, 'UPDATE');

      signal.nextUpdate = Number(
        (signal.currentPrice + 0.10).toFixed(2)
      );
    }
  }
}

async function scanMarket() {
  for (const symbol of symbols) {
    const signal = generateFakeSignal(symbol);
    await sendSignal(signal);
  }
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '🚀 ST Signals Bot يعمل بنجاح'
  );
});

bot.onText(/\/test/, async () => {
  const signal = generateFakeSignal('TSLA');
  await sendSignal(signal);
});

scanMarket();

setInterval(scanMarket, 5 * 60 * 1000);
setInterval(updateSignals, 60 * 1000);

console.log('🚀 ST Signals Bot Started');
