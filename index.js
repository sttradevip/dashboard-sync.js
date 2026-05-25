const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
  polling: true
});

// تشغيل البوت
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '🚀 ST Signals Bot يعمل بنجاح'
  );
});

// استخراج Chat ID و Thread ID
bot.onText(/\/topicid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`📌 معلومات الموضوع:

Chat ID:
${msg.chat.id}

Thread ID:
${msg.message_thread_id || 'لا يوجد'}
`
  );
});

// استقبال أسماء الأسهم
bot.on('message', async (msg) => {

  if (!msg.text) return;

  const text = msg.text.toUpperCase();

  // تجاهل الأوامر
  if (text.startsWith('/')) return;

  const allowedSymbols = [
    'TSLA',
    'NVDA',
    'AMZN',
    'SPY',
    'QQQ',
    'META'
  ];

  if (!allowedSymbols.includes(text)) return;

  await bot.sendMessage(
    msg.chat.id,
    `📊 تم استلام الرمز: ${text}`
  );
});

console.log('🚀 ST Signals Bot Started');
