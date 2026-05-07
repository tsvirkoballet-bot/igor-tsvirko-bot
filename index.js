/**
 * Igor Tsvirko Email Bot
 * Телеграм-бот для массовой рассылки писем от имени Игоря Цвирко.
 * Защищён паролем. Поддерживает большие списки и длинные сообщения.
 * Поддержка вложений: фото, документы и любые файлы.
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const nodemailer = require("nodemailer");
const path = require("path");

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
  WAITING_ATTACHMENTS: "WAITING_ATTACHMENTS",
  WAITING_CONFIRM: "WAITING_CONFIRM",
  SENDING: "SENDING",
};

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      state: STATES.IDLE,
      emails: [],
      subject: "",
      body: "",
      attachments: [], // { filename, content (Buffer), contentType }
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, {
    state: STATES.IDLE,
    emails: [],
    subject: "",
    body: "",
    attachments: [],
  });
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

// ─── Download file from Telegram by file_id ─────────────────────
async function downloadTelegramFile(fileId) {
  const stream = bot.getFileStream(fileId);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

// ─── Send a single email (with optional attachments) ────────────
async function sendEmail(recipient, subject, body, attachments = []) {
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
    attachments: attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType || undefined,
    })),
  };

  return transporter.sendMail(mailOptions);
}

// ─── Send bulk emails with progress ────────────────────────────
async function sendBulkEmails(chatId, emails, subject, body, attachments = []) {
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
      await sendEmail(email, subject, body, attachments);
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

// ─── Attachment prompt ──────────────────────────────────────────
function sendAttachmentPrompt(chatId, attachments, justAdded = null) {
  const count = attachments.length;
  let message = "";

  if (justAdded) {
    message += `✅ <b>${justAdded}</b> — добавлено!\n\n`;
  }

  if (count > 0) {
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📎 <b>Прикреплённые файлы (${count}):</b>\n`;
    message += attachments.map((a, i) => `   ${i + 1}. ${a.filename}`).join("\n");
    message += `\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📩 <b>Готовы отправить или хотите добавить ещё?</b>\n`;
    message += `Отправьте ещё фото/файл или нажмите кнопку внизу.`;
  } else {
    message += `📎 <b>Хотите прикрепить вложения к письму?</b>\n\n`;
    message += `Просто отправьте мне фото или файл прямо сейчас.\n`;
    message += `Или нажмите кнопку, чтобы пропустить.`;
  }

  bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        count > 0
          ? [
              { text: `✅ Готово — отправить (${count} влож.)`, callback_data: "attach_done" },
            ]
          : [
              { text: "⏩ Пропустить — без вложений", callback_data: "attach_done" },
            ],
      ],
    },
  });
}

// ─── Confirmation summary ───────────────────────────────────────
function sendConfirmation(chatId, session) {
  const preview = session.body.length > 200 ? session.body.substring(0, 200) + "..." : session.body;
  const attachInfo = session.attachments.length > 0
    ? `<b>Вложения (${session.attachments.length}):</b>\n${session.attachments.map((a, i) => `  ${i + 1}. ${a.filename}`).join("\n")}\n`
    : `<b>Вложения:</b> нет\n`;

  bot.sendMessage(
    chatId,
    `📋 <b>Проверьте ваше письмо:</b>\n\n` +
      `<b>От:</b> ${SENDER_NAME}\n` +
      `<b>Кому:</b> ${session.emails.length} получатель(ей)\n` +
      `<b>Тема:</b> ${session.subject}\n` +
      `${attachInfo}` +
      `<b>Превью сообщения:</b>\n<i>${preview}</i>\n\n` +
      `Готовы отправить?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [["✅ Отправить", "❌ Отмена"]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }
  );
}

// ─── /start command ─────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.state = STATES.WAITING_PASSWORD;
  session.emails = [];
  session.subject = "";
  session.body = "";
  session.attachments = [];

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
      "5️⃣ Прикрепите фото или файлы (необязательно)\n" +
      "6️⃣ Подтвердите и отправьте!\n\n" +
      "Бот поддерживает отправку сотням получателей одновременно.\n" +
      "📎 Можно прикреплять фото и документы к письмам.",
    { parse_mode: "Markdown" }
  );
});

// ─── Handle callback queries (inline buttons) ──────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const session = getSession(chatId);
  const data = query.data;

  if (data === "attach_done" && session.state === STATES.WAITING_ATTACHMENTS) {
    await bot.answerCallbackQuery(query.id);
    session.state = STATES.WAITING_CONFIRM;
    sendConfirmation(chatId, session);
  } else if (data === "attach_more_info" && session.state === STATES.WAITING_ATTACHMENTS) {
    await bot.answerCallbackQuery(query.id, { text: "Просто отправьте фото или файл 👇" });
  } else {
    await bot.answerCallbackQuery(query.id);
  }
});

// ─── Handle all messages (state machine) ────────────────────────
bot.on("message", async (msg) => {
  // Skip commands
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const session = getSession(chatId);

  // ── Handle photo/document uploads in WAITING_ATTACHMENTS state ──
  if (session.state === STATES.WAITING_ATTACHMENTS) {
    // Handle photo
    if (msg.photo && msg.photo.length > 0) {
      const loadingMsg = await bot.sendMessage(chatId, "⏳ Загружаю фото...");
      try {
        const photo = msg.photo[msg.photo.length - 1];
        const buffer = await downloadTelegramFile(photo.file_id);
        const file = await bot.getFile(photo.file_id);
        const ext = path.extname(file.file_path) || ".jpg";
        const filename = `photo_${session.attachments.length + 1}${ext}`;

        session.attachments.push({
          filename,
          content: buffer,
          contentType: `image/${ext.replace(".", "") === "jpg" ? "jpeg" : ext.replace(".", "")}`,
        });

        try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch (e) {}

        const count = session.attachments.length;
        await bot.sendMessage(
          chatId,
          `✅ <b>Фото добавлено!</b> (${filename})\n\n` +
            `📎 Всего вложений: <b>${count}</b>\n\n` +
            `Хотите добавить ещё фото/файл?\nИли готовы отправить?`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: `📩 Отправить письмо (${count} влож.)`, callback_data: "attach_done" }],
                [{ text: "➕ Добавлю ещё — просто скину", callback_data: "attach_more_info" }],
              ],
            },
          }
        );
      } catch (err) {
        console.error("Ошибка загрузки фото:", err.message, err.stack);
        try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch (e) {}
        bot.sendMessage(chatId, `⚠️ Не удалось загрузить фото. Попробуйте ещё раз.\nОшибка: ${err.message}`);
      }
      return;
    }

    // Handle document/file
    if (msg.document) {
      const loadingMsg = await bot.sendMessage(chatId, "⏳ Загружаю файл...");
      try {
        const doc = msg.document;
        const buffer = await downloadTelegramFile(doc.file_id);
        const filename = doc.file_name || `file_${session.attachments.length + 1}`;

        session.attachments.push({
          filename,
          content: buffer,
          contentType: doc.mime_type || "application/octet-stream",
        });

        try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch (e) {}

        const count = session.attachments.length;
        await bot.sendMessage(
          chatId,
          `✅ <b>Файл добавлен!</b> (${filename})\n\n` +
            `📎 Всего вложений: <b>${count}</b>\n\n` +
            `Хотите добавить ещё фото/файл?\nИли готовы отправить?`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: `📩 Отправить письмо (${count} влож.)`, callback_data: "attach_done" }],
                [{ text: "➕ Добавлю ещё — просто скину", callback_data: "attach_more_info" }],
              ],
            },
          }
        );
      } catch (err) {
        console.error("Ошибка загрузки файла:", err.message, err.stack);
        try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch (e) {}
        bot.sendMessage(chatId, `⚠️ Не удалось загрузить файл. Попробуйте ещё раз.\nОшибка: ${err.message}`);
      }
      return;
    }

    // If they send text while waiting for attachments
    if (msg.text) {
      bot.sendMessage(chatId, "⚠️ Отправьте фото или файл, либо нажмите кнопку выше.");
      return;
    }

    return;
  }

  // ── Text-based state machine ───────────────────────────────────
  if (!msg.text) return;
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
      session.state = STATES.WAITING_ATTACHMENTS;

      // Show attachment prompt — user can just send photos/files directly
      sendAttachmentPrompt(chatId, session.attachments);
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
          session.body,
          session.attachments
        );

        // Final report (plain text fallback to avoid markdown issues)
        let report =
          `📊 Рассылка завершена!\n\n` +
          `✅ Успешно отправлено: ${success}\n` +
          `❌ Ошибки: ${fail}\n` +
          `📬 Всего: ${session.emails.length}`;

        if (session.attachments.length > 0) {
          report += `\n📎 Вложений: ${session.attachments.length}`;
        }

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
