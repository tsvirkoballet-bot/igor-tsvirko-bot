/**
 * Igor Tsvirko Email Bot
 * Телеграм-бот для массовой рассылки писем от имени Игоря Цвирко.
 * Защищён паролем. Поддерживает большие списки и длинные сообщения.
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const nodemailer = require("nodemailer");

// ─── Configuration ──────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PASSWORD = process.env.BOT_PASSWORD || "tsvirko89";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_EMAIL = process.env.SMTP_EMAIL;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SENDER_NAME = process.env.SENDER_NAME || "Igor Tsvirko";

// ─── Validation ─────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error("ОШИБКА: BOT_TOKEN не установлен в переменных окружения");
  process.exit(1);
}
if (!SMTP_EMAIL || !SMTP_PASSWORD) {
  console.error("ОШИБКА: SMTP_EMAIL и SMTP_PASSWORD должны быть установлены в переменных окружения");
  process.exit(1);
}

// ─── SMTP Transporter ──────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // true for 465, false for other ports (STARTTLS)
  auth: {
    user: SMTP_EMAIL,
    pass: SMTP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false,
  },
  // Pool for handling bulk emails efficiently
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  rateDelta: 1000,
  rateLimit: 5,
});

// ─── Bot Setup (polling mode — runs 24/7 on Bothost) ────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Per-user session state
const sessions = new Map();

// Conversation states
const STATES = {
  IDLE: "IDLE",
  WAITING_PASSWORD: "WAITING_PASSWORD",
  WAITING_EMAILS: "WAITING_EMAILS",
  WAITING_SUBJECT: "WAITING_SUBJECT",
  WAITING_MESSAGE: "WAITING_MESSAGE",
  WAITING_CONFIRM: "WAITING_CONFIRM",
  SENDING: "SENDING",
};

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { state: STATES.IDLE, emails: [], subject: "", body: "" });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { state: STATES.IDLE, emails: [], subject: "", body: "" });
}

// ─── Email regex ────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function parseEmails(text) {
  const found = text.match(EMAIL_RE) || [];
  // Deduplicate, preserving order
  const seen = new Set();
  const unique = [];
  for (const email of found) {
    const lower = email.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(email);
    }
  }
  return unique;
}

// ─── Escape markdown ───────────────────────────────────────────
function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#\+\-=|{}.!])/g, "\\$1");
}

// ─── Send a single email ───────────────────────────────────────
async function sendEmail(recipient, subject, body) {
  // Create plain text version
  const plainText = body;

  // Create HTML version (preserves line breaks)
  const htmlBody = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">
      ${htmlBody}
    </div>`;

  const mailOptions = {
    from: `"${SENDER_NAME}" <${SMTP_EMAIL}>`,
    to: recipient,
    subject: subject,
    text: plainText,
    html: html,
  };

  return transporter.sendMail(mailOptions);
}

// ─── Send bulk emails with progress ────────────────────────────
async function sendBulkEmails(chatId, emails, subject, body) {
  let success = 0;
  let fail = 0;
  const errors = [];
  const total = emails.length;
  const batchSize = 10;

  // Send initial progress message
  const progressMsg = await bot.sendMessage(chatId, `📤 Отправка писем... 0/${total}`);

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      await sendEmail(email, subject, body);
      success++;
    } catch (err) {
      fail++;
      let errMsg = err.message || String(err);
      if (errMsg.length > 100) errMsg = errMsg.substring(0, 100) + "...";
      errors.push(`❌ ${email}: ${errMsg}`);
      console.error(`Ошибка отправки на ${email}:`, err.message);
    }

    // Update progress every batchSize emails or on the last one
    if ((i + 1) % batchSize === 0 || i + 1 === total) {
      try {
        await bot.editMessageText(
          `📤 Отправка писем... ${i + 1}/${total}\n✅ Отправлено: ${success}  ❌ Ошибки: ${fail}`,
          { chat_id: chatId, message_id: progressMsg.message_id }
        );
      } catch (e) {
        // Ignore edit errors
      }
    }

    // Small delay between sends to avoid rate limiting
    if (i < emails.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return { success, fail, errors };
}

// ─── /start command ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.state = STATES.WAITING_PASSWORD;
  session.emails = [];
  session.subject = "";
  session.body = "";

  bot.sendMessage(
    chatId,
    "🩰 *Добро пожаловать в Email-бот Игоря Цвирко*\n\nВведите пароль для продолжения:",
    { parse_mode: "Markdown" }
  );
});

// ─── /cancel command ────────────────────────────────────────────
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  bot.sendMessage(chatId, "❌ Операция отменена. Используйте /start чтобы начать заново.", {
    reply_markup: { remove_keyboard: true },
  });
});

// ─── /help command ──────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "🩰 *Email-бот Игоря Цвирко — Помощь*\n\n" +
      "*Команды:*\n" +
      "/start — Начать рассылку\n" +
      "/cancel — Отменить текущую операцию\n" +
      "/help — Показать справку\n\n" +
      "*Как это работает:*\n" +
      "1️⃣ Введите пароль\n" +
      "2️⃣ Отправьте список email-адресов\n" +
      "3️⃣ Введите тему письма\n" +
      "4️⃣ Введите текст письма\n" +
      "5️⃣ Подтвердите и отправьте!\n\n" +
      "Бот поддерживает отправку сотням получателей одновременно.",
    { parse_mode: "Markdown" }
  );
});

// ─── Handle all text messages (state machine) ──────────────────
bot.on("message", async (msg) => {
  // Skip commands
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const text = msg.text;

  switch (session.state) {
    // ── PASSWORD ─────────────────────────────────
    case STATES.WAITING_PASSWORD: {
      if (text.trim() === BOT_PASSWORD) {
        session.state = STATES.WAITING_EMAILS;
        bot.sendMessage(
          chatId,
          "✅ *Доступ разрешён!*\n\n" +
            "Теперь отправьте мне email-адреса.\n" +
            "Можно через запятую, пробел или каждый с новой строки.\n\n" +
            "📧 Пример:\n" +
            "`email1@example.com, email2@example.com`\n" +
            "или по одному на строку.",
          { parse_mode: "Markdown" }
        );
      } else {
        bot.sendMessage(chatId, "🚫 *Неверный пароль.* Попробуйте ещё раз или /cancel для выхода.", {
          parse_mode: "Markdown",
        });
      }
      break;
    }

    // ── EMAILS ───────────────────────────────────
    case STATES.WAITING_EMAILS: {
      const emails = parseEmails(text);
      if (emails.length === 0) {
        bot.sendMessage(
          chatId,
          "⚠️ Не найдено ни одного валидного email-адреса. Попробуйте ещё раз.\nУбедитесь, что адреса в формате `user@domain.com`.",
          { parse_mode: "Markdown" }
        );
      } else {
        session.emails = emails;
        session.state = STATES.WAITING_SUBJECT;

        // Show list (max 20 displayed)
        let emailList = emails.slice(0, 20).map((e) => `• ${e}`).join("\n");
        if (emails.length > 20) {
          emailList += `\n...и ещё ${emails.length - 20}`;
        }

        bot.sendMessage(
          chatId,
          `📬 *Получено ${emails.length} адрес(ов):*\n\n${emailList}\n\n✏️ Теперь введите *тему письма*:`,
          { parse_mode: "Markdown" }
        );
      }
      break;
    }

    // ── SUBJECT ──────────────────────────────────
    case STATES.WAITING_SUBJECT: {
      if (!text.trim()) {
        bot.sendMessage(chatId, "⚠️ Тема не может быть пустой. Попробуйте ещё раз:");
        break;
      }
      session.subject = text.trim();
      session.state = STATES.WAITING_MESSAGE;
      bot.sendMessage(
        chatId,
        "✅ Тема сохранена.\n\n📝 Теперь отправьте *текст письма*.\nМожно отправлять сколько угодно текста — длинные сообщения полностью поддерживаются.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    // ── MESSAGE ──────────────────────────────────
    case STATES.WAITING_MESSAGE: {
      if (!text.trim()) {
        bot.sendMessage(chatId, "⚠️ Сообщение не может быть пустым. Попробуйте ещё раз:");
        break;
      }
      session.body = text;
      session.state = STATES.WAITING_CONFIRM;

      const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;

      bot.sendMessage(
        chatId,
        `📋 *Проверьте ваше письмо:*\n\n` +
          `*От:* ${SENDER_NAME}\n` +
          `*Кому:* ${session.emails.length} получатель(ей)\n` +
          `*Тема:* ${session.subject}\n` +
          `*Превью сообщения:*\n_${preview}_\n\n` +
          `Готовы отправить?`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [["✅ Отправить", "❌ Отмена"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
      break;
    }

    // ── CONFIRM ──────────────────────────────────
    case STATES.WAITING_CONFIRM: {
      if (text === "✅ Отправить") {
        session.state = STATES.SENDING;

        bot.sendMessage(chatId, "🚀 Начинаю отправку писем...", {
          reply_markup: { remove_keyboard: true },
        });

        const { success, fail, errors } = await sendBulkEmails(
          chatId,
          session.emails,
          session.subject,
          session.body
        );

        // Final report (plain text fallback to avoid markdown issues)
        let report =
          `📊 Рассылка завершена!\n\n` +
          `✅ Успешно отправлено: ${success}\n` +
          `❌ Ошибки: ${fail}\n` +
          `📬 Всего: ${session.emails.length}`;

        if (errors.length > 0) {
          const errorDetails = errors.slice(0, 10).join("\n");
          const moreErrors = errors.length > 10 ? `\n...и ещё ${errors.length - 10} ошибок` : "";
          report += `\n\nПодробности ошибок:\n${errorDetails}${moreErrors}`;
        }

        report += "\n\nИспользуйте /start для новой рассылки.";

        await bot.sendMessage(chatId, report);

        resetSession(chatId);
      } else if (text === "❌ Отмена") {
        resetSession(chatId);
        bot.sendMessage(chatId, "❌ Отменено. Используйте /start чтобы начать заново.", {
          reply_markup: { remove_keyboard: true },
        });
      } else {
        bot.sendMessage(chatId, "Пожалуйста, выберите один из вариантов:", {
          reply_markup: {
            keyboard: [["✅ Отправить", "❌ Отмена"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        });
      }
      break;
    }

    // ── IDLE / DEFAULT ───────────────────────────
    default: {
      bot.sendMessage(
        chatId,
        "🩰 Добро пожаловать! Используйте /start чтобы начать рассылку, или /help для справки."
      );
      break;
    }
  }
});

// ─── Error handling ──────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Ошибка polling:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("Необработанная ошибка:", err);
});

// ─── Start ───────────────────────────────────────────────────────
console.log("🩰 Email-бот Игоря Цвирко запущен!");
console.log(`📧 Отправка от имени: ${SENDER_NAME} <${SMTP_EMAIL}>`);
console.log("✅ Бот работает (polling). Ожидание сообщений...");
