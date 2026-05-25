const TelegramBot = require('node-telegram-bot-api');
const { createCanvas } = require('canvas');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
  polling: true
});

// معلومات القناة
const CHAT_ID = '-1002840761137';
const THREAD_ID = 12385;

// الأسهم المسموحة
const symbols = ['TSLA', 'NVDA', 'AMZN', 'SPY', 'QQQ', 'META'];

// حفظ الصفقات الحالية
const activeTrades = {};

// إنشاء صورة احترافية
async function createTradeImage(symbol, type, entry) {

  const canvas = createCanvas(800, 450);
  const ctx = canvas.getContext('2d');

  // خلفية
  ctx.fillStyle = '#050816';
  ctx.fillRect(0, 0, 800, 450);

  // إطار
  ctx.strokeStyle = type === 'CALL' ? '#00ff99' : '#ff2d55';
  ctx.lineWidth = 8;

  ctx.beginPath();
  ctx.roundRect(20, 20, 760, 410, 25);
  ctx.stroke();

  // عنوان
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px "DejaVu Sans"';
  ctx.textAlign = 'center';

  ctx.fillText('ST TRADE VIP', 400, 90);

  // اسم السهم
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 90px "DejaVu Sans"';

  ctx.fillText(symbol, 400, 210);

  // نوع العقد
  ctx.fillStyle = type === 'CALL' ? '#00ff99' : '#ff2d55';
  ctx.font = 'bold 60px "DejaVu Sans"';

  ctx.fillText(type, 400, 300);

  // السعر
  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 55px "DejaVu Sans"';

  ctx.fillText(`$${entry}`, 400, 380);

  return canvas.toBuffer();
}

// إرسال صفقة جديدة
async function sendNewTrade(symbol) {

  const type = Math.random() > 0.5 ? 'CALL' : 'PUT';

  const entry = (1.50 + Math.random()).toFixed(2);

  const strike = Math.floor(200 + Math.random() * 300);

  const stop = (entry - 0.30).toFixed(2);

  const target = (parseFloat(entry) + 0.80).toFixed(2);

  activeTrades[symbol] = {
    symbol,
    type,
    strike,
    entry: parseFloat(entry),
    current: parseFloat(entry),
    stop: parseFloat(stop),
    target: parseFloat(target)
  };

  const image = await createTradeImage(
    symbol,
    type,
    entry
  );

  const text = `
🚨 صفقة جديدة

📊 السهم: ${symbol}

📈 نوع العقد: ${type}

🎯 السترايك: ${strike}

💰 سعر الدخول: $${entry}

🛑 وقف الخسارة: $${stop}

🎯 الهدف: $${target}

🔥 ST TRADE VIP
`;

  await bot.sendPhoto(
    CHAT_ID,
    image,
    {
      caption: text,
      message_thread_id: THREAD_ID
    }
  );
}

// تحديث الصفقات
async function updateTrades() {

  for (const symbol in activeTrades) {

    const trade = activeTrades[symbol];

    const move = (Math.random() * 0.20 - 0.05);

    trade.current += move;

    trade.current =
      parseFloat(trade.current.toFixed(2));

    const profit =
      (
        ((trade.current - trade.entry)
        / trade.entry) * 100
      ).toFixed(2);

    // تحديث كل 0.10
    if (
      Math.abs(
        trade.current - trade.entry
      ) >= 0.10
    ) {

      const text = `
🚨 تحديث الصفقة

📊 السهم: ${trade.symbol}

📈 نوع العقد: ${trade.type}

🎯 السترايك: ${trade.strike}

💰 الدخول: $${trade.entry.toFixed(2)}

💵 السعر الحالي: $${trade.current.toFixed(2)}

📈 نسبة الربح: ${profit}%

🛑 الوقف: $${trade.stop.toFixed(2)}

🎯 الهدف: $${trade.target.toFixed(2)}

🔥 ST TRADE VIP
`;

      await bot.sendMessage(
        CHAT_ID,
        text,
        {
          message_thread_id: THREAD_ID
        }
      );

      trade.entry = trade.current;
    }

    // قرب الوقف
    if (
      trade.current <= trade.stop + 0.05 &&
      trade.current > trade.stop
    ) {

      await bot.sendMessage(
        CHAT_ID,
`
⚠️ تنبيه

الصفقة على ${trade.symbol}
اقتربت من وقف الخسارة

💵 السعر الحالي:
$${trade.current.toFixed(2)}
`,
        {
          message_thread_id: THREAD_ID
        }
      );
    }

    // ضرب الوقف
    if (trade.current <= trade.stop) {

      await bot.sendMessage(
        CHAT_ID,
`
❌ تم ضرب وقف الخسارة

📊 ${trade.symbol}

💵 السعر:
$${trade.current.toFixed(2)}
`,
        {
          message_thread_id: THREAD_ID
        }
      );

      delete activeTrades[symbol];

      continue;
    }

    // تحقق الهدف
    if (trade.current >= trade.target) {

      await bot.sendMessage(
        CHAT_ID,
`
✅ تحقق الهدف

📊 ${trade.symbol}

💵 السعر:
$${trade.current.toFixed(2)}

📈 الربح النهائي:
${profit}%
`,
        {
          message_thread_id: THREAD_ID
        }
      );

      delete activeTrades[symbol];
    }
  }
}

// تشغيل البوت
bot.onText(/\/start/, async (msg) => {

  await bot.sendMessage(
    msg.chat.id,
    '🚀 ST Signals Bot يعمل بنجاح'
  );
});

// إرسال صفقات تجريبية تلقائياً
setInterval(async () => {

  const randomSymbol =
    symbols[
      Math.floor(
        Math.random() * symbols.length
      )
    ];

  if (!activeTrades[randomSymbol]) {

    await sendNewTrade(randomSymbol);
  }

}, 60000);

// تحديث الصفقات
setInterval(updateTrades, 30000);

console.log('🚀 ST Signals Bot Started');
