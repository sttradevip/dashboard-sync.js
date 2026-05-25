const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
  polling: true
});

// ===============================
// إعدادات القناة والموضوع
// ===============================

const CHANNEL_ID = -1002840761137;
const THREAD_ID = 12385;

// ===============================
// الأسهم المسموحة
// ===============================

const allowedSymbols = [
  'TSLA',
  'NVDA',
  'AMZN',
  'SPY',
  'QQQ',
  'META'
];

// ===============================
// تخزين الصفقات
// ===============================

const activeSignals = {};

// ===============================
// إنشاء صورة احترافية
// ===============================

async function createCard(signal) {

  const isCall = signal.type === 'CALL';

  const mainColor = isCall
    ? '#00e676'
    : '#ff1744';

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

  <text
    x="540"
    y="150"
    text-anchor="middle"
    fill="#ffffff"
    font-size="64"
    font-family="Arial"
    font-weight="bold">
    ST TRADE VIP
  </text>

  <text
    x="540"
    y="390"
    text-anchor="middle"
    fill="#ffffff"
    font-size="170"
    font-family="Arial"
    font-weight="bold">
    ${signal.symbol}
  </text>

  <text
    x="540"
    y="560"
    text-anchor="middle"
    fill="${mainColor}"
    font-size="125"
    font-family="Arial"
    font-weight="bold">
    ${signal.type}
  </text>

  <text
    x="540"
    y="760"
    text-anchor="middle"
    fill="#ffffff"
    font-size="165"
    font-family="Arial"
    font-weight="bold">
    $${signal.currentPrice.toFixed(2)}
  </text>

  <text
    x="540"
    y="930"
    text-anchor="middle"
    fill="#8f8f9a"
    font-size="44"
    font-family="Arial"
    font-weight="bold">
    ST OPTIONS SIGNAL
  </text>

</svg>
`;

  const fileName = `signal-${Date.now()}.png`;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(fileName);

  return fileName;
}

// ===============================
// إنشاء صفقة
// ===============================

function generateSignal(symbol) {

  const type = Math.random() > 0.5
    ? 'CALL'
    : 'PUT';

  const strike = Math.floor(
    100 + Math.random() * 400
  );

  const entry = Number(
    (1.50 + Math.random()).toFixed(2)
  );

  const stopLoss = Number(
    (entry - 0.40).toFixed(2)
  );

  const target = Number(
    (entry + 0.80).toFixed(2)
  );

  return {
    symbol,
    type,
    strike,
    entry,
    currentPrice: entry,
    stopLoss,
    target,
    updates: 0
  };
}

// ===============================
// إرسال صفقة جديدة
// ===============================

async function sendSignal(signal) {

  const image = await createCard(signal);

  const text = `
🚨 صفقة جديدة

📊 السهم:
${signal.symbol}

📈 نوع العقد:
${signal.type}

🎯 السترايك:
${signal.strike}

💰 سعر الدخول:
$${signal.entry}

🛑 وقف الخسارة:
$${signal.stopLoss}

🎯 الهدف:
$${signal.target}

🔥 ST TRADE VIP
`;

  await bot.sendPhoto(
    CHANNEL_ID,
    image,
    {
      caption: text,
      message_thread_id: THREAD_ID
    }
  );
}

// ===============================
// تحديث الصفقة
// ===============================

async function updateSignal(signal) {

  const moveUp = Math.random() > 0.5;

  if (moveUp) {
    signal.currentPrice += 0.10;
  } else {
    signal.currentPrice -= 0.10;
  }

  signal.currentPrice = Number(
    signal.currentPrice.toFixed(2)
  );

  const pnl = (
    (
      (signal.currentPrice - signal.entry)
      / signal.entry
    ) * 100
  ).toFixed(2);

  // قرب الوقف
  if (
    signal.currentPrice <=
    signal.stopLoss + 0.10
  ) {

    await bot.sendMessage(
      CHANNEL_ID,
`
⚠️ تنبيه مهم

العقد قريب من وقف الخسارة

📊 ${signal.symbol}
📈 ${signal.type}

💰 السعر الحالي:
$${signal.currentPrice}

📉 نسبة الخسارة:
${pnl}%
`,
      {
        message_thread_id: THREAD_ID
      }
    );
  }

  // ضرب الوقف
  if (
    signal.currentPrice <= signal.stopLoss
  ) {

    await bot.sendMessage(
      CHANNEL_ID,
`
❌ تم ضرب وقف الخسارة

📊 ${signal.symbol}
📈 ${signal.type}

💰 السعر النهائي:
$${signal.currentPrice}

📉 الخسارة:
${pnl}%
`,
      {
        message_thread_id: THREAD_ID
      }
    );

    delete activeSignals[signal.symbol];

    return;
  }

  // تحقق الهدف
  if (
    signal.currentPrice >= signal.target
  ) {

    await bot.sendMessage(
      CHANNEL_ID,
`
🎯 تحقق الهدف بنجاح

📊 ${signal.symbol}
📈 ${signal.type}

💰 السعر النهائي:
$${signal.currentPrice}

📈 الربح:
+${pnl}%
`,
      {
        message_thread_id: THREAD_ID
      }
    );

    delete activeSignals[signal.symbol];

    return;
  }

  // تحديث عادي
  const image = await createCard(signal);

  await bot.sendPhoto(
    CHANNEL_ID,
    image,
    {
      caption:
`
🚨 تحديث الصفقة

📊 السهم:
${signal.symbol}

📈 نوع العقد:
${signal.type}

💰 السعر الحالي:
$${signal.currentPrice}

📊 نسبة الربح / الخسارة:
${pnl}%

🎯 الهدف:
$${signal.target}

🛑 الوقف:
$${signal.stopLoss}

🔥 ST TRADE VIP
`,
      message_thread_id: THREAD_ID
    }
  );
}

// ===============================
// إرسال تلقائي
// ===============================

async function autoScanner() {

  const symbol =
    allowedSymbols[
      Math.floor(
        Math.random() * allowedSymbols.length
      )
    ];

  // منع تكرار نفس السهم
  if (activeSignals[symbol]) {
    return;
  }

  const signal = generateSignal(symbol);

  activeSignals[symbol] = signal;

  await sendSignal(signal);

  // تحديثات مستمرة
  const interval = setInterval(async () => {

    if (!activeSignals[symbol]) {
      clearInterval(interval);
      return;
    }

    await updateSignal(signal);

  }, 60000);
}

// ===============================
// تشغيل تلقائي كل 5 دقائق
// ===============================

setInterval(() => {
  autoScanner();
}, 300000);

// ===============================
// أوامر البوت
// ===============================

bot.onText(/\/start/, async (msg) => {

  await bot.sendMessage(
    msg.chat.id,
    '🚀 ST Signals Bot يعمل بنجاح'
  );

});

// ===============================
// استخراج IDs
// ===============================

bot.onText(/\/topicid/, async (msg) => {

  await bot.sendMessage(
    msg.chat.id,
`
📌 معلومات الموضوع

Chat ID:
${msg.chat.id}

Thread ID:
${msg.message_thread_id || 'لا يوجد'}
`
  );

});

// ===============================
// فحص يدوي
// ===============================

bot.onText(/\/scan (.+)/, async (msg, match) => {

  const symbol = match[1]
    .toUpperCase()
    .trim();

  if (
    !allowedSymbols.includes(symbol)
  ) {

    return bot.sendMessage(
      msg.chat.id,
      '❌ السهم غير مدعوم'
    );
  }

  const signal = generateSignal(symbol);

  activeSignals[symbol] = signal;

  await sendSignal(signal);

});

// ===============================

console.log('🚀 ST Signals Bot Started');
