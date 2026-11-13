/**
 * Every text the user can see, in one place.
 *
 * Style guide (keep new messages consistent with it):
 * - Persian only; the only Latin text allowed is "PDF" and command names.
 * - Friendly, informal "تو" voice (می‌تونی، بفرست، دوباره امتحان کن).
 * - Bold (**...**) only for section titles; one emoji at the start of a section.
 * - Commands are always written with cmd(), e.g. cmd("/delete 3").
 * - Buttons do the common actions; typed commands keep working.
 */
import type { DocumentStatus } from "./db/documents.js";
import { isPhotoFilename } from "./rag/documentKind.js";

/** Left-to-right mark (invisible). */
const LRM = "‎";

/**
 * A command as shown to users. Inside right-to-left Persian text, clients
 * reorder "/delete 3" into "3 /delete"; the marks keep it in order.
 */
const cmd = (command: string): string => `${LRM}${command}${LRM}`;

// --- Main menu (keyboard at the bottom of the chat) ---------------------------

export const MENU_DOCUMENTS = "📚 جزوه‌های من";
export const MENU_HELP = "❓ راهنما";
export const MENU_ABOUT = "ℹ️ درباره";
export const MENU_NEW_TOPIC = "🆕 موضوع جدید";

export const MAIN_MENU: string[][] = [
  [MENU_DOCUMENTS, MENU_NEW_TOPIC],
  [MENU_HELP, MENU_ABOUT],
];

export const NEW_TOPIC_TEXT = `🆕 باشه، از اینجا موضوع جدید شروع می‌شه. سؤال بعدی‌ت رو به گفت‌وگوی قبلی ربط نمی‌دم.`;

// --- Info commands -----------------------------------------------------------

export const START_TEXT = `سلام! 👋 به دانشجویار خوش اومدی.

🎓 من دستیار هوشمند مطالعه‌ات هستم. جزوه‌هات رو به‌صورت PDF یا عکس برام بفرست تا بتونی درباره‌شون ازم سؤال بپرسی.

📌 **برای شروع:**
۱. فایل PDF جزوه‌ات یا عکس یک صفحه‌ش رو بفرست.
۲. صبر کن تا پردازش فایل تموم بشه.
۳. سؤالت رو بپرس تا بر اساس جزوه جوابت رو بدم.

از دکمه‌های پایین صفحه هم می‌تونی جزوه‌هات و راهنما رو ببینی.

یادگیری بهتر، قدم‌به‌قدم! 🌱`;

export const HELP_TEXT = `📚 **راهنمای دانشجویار**

من بهت کمک می‌کنم راحت‌تر درس بخونی و جواب سؤال‌هات رو از روی جزوه‌هات پیدا کنی.

**چطور ازم استفاده کنی؟**

📄 **۱. فرستادن جزوه**
یک فایل PDF یا عکس یک صفحه از جزوه‌ات رو بفرست. خوندن صفحه‌های اسکن‌شده و عکس‌ها برای هر صفحه حدود یک دقیقه طول می‌کشه.
هر عکس یک جزوه جدا می‌شه؛ برای چند صفحه بهتره PDF بفرستی. اگه متن عکسی درست خونده نشد، عکس رو به‌صورت فایل بفرست تا کیفیتش کم نشه.

💬 **۲. پرسیدن سؤال**
سؤالت رو بپرس؛ خودم توی همه جزوه‌هات می‌گردم و جواب رو با اسم فایل و شماره صفحه بهت می‌دم. لازم نیست جزوه‌ای رو انتخاب کنی. زیر هر جواب با 👍 یا 👎 بگو مفید بود یا نه.

📝 **۳. خلاصه**
بگو کدوم جزوه یا چه موضوعی رو خلاصه کنم، مثلاً «جزوه ساختمان داده رو خلاصه کن».

📚 **۴. مدیریت جزوه‌ها**
دکمه «${MENU_DOCUMENTS}» رو بزن؛ زیر فهرست، برای حذف هر جزوه دکمه هست.

🆕 **موضوع جدید**
سؤال‌های کوتاهی مثل «بیشتر توضیح بده» رو به گفت‌وگوی قبلی ربط می‌دم. برای شروع یک موضوع تازه دکمه «${MENU_NEW_TOPIC}» رو بزن یا ${cmd("/new")} رو بفرست؛ گفت‌وگوی قدیمی‌تر از یک ساعت هم خودش کنار گذاشته می‌شه.

🌐 **۵. سؤال‌های عمومی**
اگه سؤالت به جزوه‌هات ربطی نداشته باشه، مثل یک دستیار هوشمند معمولی جوابت رو می‌دم.`;

export const ABOUT_TEXT = `🎓 **دانشجویار** | دستیار هوشمند مطالعه

دانشجویار یک دستیار مطالعه در پیام‌رسان بله است که با کمک هوش مصنوعی، مرور و فهمیدن مطالب درسی رو راحت‌تر می‌کنه.

✨ **امکانات فعلی:**
📄 دریافت و پردازش فایل‌های PDF (حتی اسکن‌شده) و عکس صفحه‌های جزوه
💬 جواب دادن به سؤال‌های درسی از روی همه جزوه‌هات
📚 دیدن جزوه‌ها
🗑️ حذف جزوه‌های ذخیره‌شده
⏹️ لغو درخواست‌های در حال انجام

دانشجویار هنوز در حال توسعه‌ست و مدام بهتر می‌شه.

یادگیری بهتر، قدم‌به‌قدم! 🌱`;

// --- Documents ---------------------------------------------------------------

/**
 * How a document is named to the student. A photo's file name says nothing
 * ("capture_6791184992758507927.jpg"), so once enriched it is named by its
 * generated title; a PDF keeps its file name, which the student chose.
 */
export const documentDisplayName = (filename: string, title?: string | null): string =>
  isPhotoFilename(filename) && title ? `عکس «${title}»` : filename;

export const DOCUMENT_STATUS_TEXT: Record<DocumentStatus, string> = {
  pending: "در انتظار پردازش",
  processing: "در حال پردازش",
  completed: "آماده مطالعه",
  failed: "پردازش ناموفق",
};

export const NO_DOCUMENTS_TEXT =
  "هنوز هیچ جزوه‌ای نفرستادی.\n\nبرای شروع، یک فایل PDF یا عکس جزوه‌ات رو برام بفرست. 📄";

/** Button label under each document in the list. */
export const DELETE_BUTTON = "🗑️ حذف";

/** The document's name on its button: 📄 ready, ⏳ still processing, ⚠️ failed. */
export const documentNameButton = (name: string, status: DocumentStatus): string => {
  const icon = status === "failed" ? "⚠️" : status === "completed" ? "📄" : "⏳";
  return `${icon} ${name}`;
};

/** Bale (like Telegram) shows at most 200 characters in a button's popup. */
const POPUP_MAX = 200;

/**
 * Popup when a document's name is tapped (names on buttons are shortened):
 * its full name and status, and once enriched its title and main topics.
 */
export const documentInfoText = (
  filename: string,
  status: DocumentStatus,
  title?: string | null,
  topics?: string[] | null,
): string => {
  const text =
    `${filename}\nوضعیت: ${DOCUMENT_STATUS_TEXT[status]}` +
    (title ? `\nموضوع: ${title}` : "") +
    (topics && topics.length > 0 ? `\nمباحث: ${topics.join("، ")}` : "");
  return text.length > POPUP_MAX ? `${text.slice(0, POPUP_MAX - 1)}…` : text;
};

export const DOCUMENTS_LIST_TEXT =
  `📚 **جزوه‌های تو**\n\n` +
  `سؤال‌هات رو از روی همه این جزوه‌ها جواب می‌دم.\n\n` +
  `👇 روی اسم هر جزوه بزن تا اسم کاملش رو ببینی، و برای پاک کردنش «${DELETE_BUTTON}» رو بزن.`;

// --- Deleting a document -------------------------------------------------------

export const DELETE_CONFIRM_BUTTON = "✅ بله، حذف کن";
export const DELETE_CANCEL_BUTTON = "❌ انصراف";

export const DELETE_USAGE_TEXT = `شناسه جزوه رو این‌طوری وارد کن:\n${cmd("/delete 1")}`;

export const DELETE_NOT_FOUND_TEXT = `این جزوه پیدا نشد یا مال تو نیست. فهرست جزوه‌ها: ${cmd("/documents")}`;

export const deleteConfirmationText = (
  filename: string,
  documentId: number,
): string =>
  `🗑️ **تأیید حذف جزوه**\n\n` +
  `نام فایل: ${filename}\n` +
  `شناسه: ${documentId}\n\n` +
  `مطمئنی می‌خوای این جزوه رو حذف کنی؟ روی یکی از دکمه‌های زیر بزن.\n\n` +
  `⚠️ با حذف جزوه، محتوای ذخیره‌شده‌ش هم برای همیشه پاک می‌شه. این درخواست فقط یک دقیقه معتبره.`;

export const NO_PENDING_DELETE_TEXT = `درخواست حذفی در انتظار نیست (شاید بیشتر از یک دقیقه گذشته). دوباره از فهرست جزوه‌ها حذفش کن: ${cmd("/documents")}`;

export const deleteSucceededText = (documentId: number): string =>
  `✅ جزوه شماره ${documentId} حذف شد.`;

export const DELETE_FAILED_TEXT =
  "❌ جزوه حذف نشد. شاید قبلاً حذف شده یا مال تو نیست.";

export const NO_PENDING_DELETE_TO_CANCEL_TEXT =
  "درخواست حذفی برای لغو کردن وجود نداره.";

export const DELETE_CANCELLED_TEXT = "حذف لغو شد. جزوه‌ات سر جاشه. 👍";

// --- Uploading a PDF or a photo ---------------------------------------------------

/** A file that is neither a PDF nor a photo (JPEG, PNG, WebP). */
export const UNSUPPORTED_FILE_TEXT =
  "📎 این نوع فایل رو نمی‌تونم بخونم. جزوه‌ات رو به‌صورت فایل PDF یا عکس بفرست.";

/** A sticker, voice message, video, location, ... */
export const UNSUPPORTED_MESSAGE_TEXT =
  "فعلاً فقط پیام متنی، فایل PDF و عکس رو می‌فهمم. سؤالت رو بنویس، یا جزوه‌ات رو به‌صورت PDF یا عکس بفرست.";

export const FILE_TOO_LARGE_TEXT =
  "حجم فایل بیشتر از ۲۰ مگابایته. لطفاً فایل کوچک‌تری بفرست.";

/** The same file (name and size) was already uploaded by this user. */
export const duplicateDocumentText = (filename: string, stillProcessing: boolean): string =>
  stillProcessing
    ? `📎 فایل «${filename}» رو قبلاً فرستادی و الان در حال پردازشه. یه کم صبر کن تا آماده بشه.`
    : `📎 فایل «${filename}» رو قبلاً فرستادی و توی جزوه‌هات هست، پس دوباره ذخیره‌ش نکردم.\n\n` +
      `می‌تونی همین الان ازش سؤال بپرسی.`;

export const FILE_RECEIVED_TEXT =
  "📥 فایلت رسید. دارم پردازشش می‌کنم، یه کم صبر کن...";

export const PHOTO_RECEIVED_TEXT =
  "📥 عکست رسید. دارم متنش رو می‌خونم؛ حدود یک دقیقه طول می‌کشه...";

export const ocrStartedText = (
  total: number,
  skipped: number,
  minutes: number,
): string =>
  `🔍 ${total} صفحه از این فایل متن قابل‌خوندن نداره (اسکن‌شده یا خرابه) و باید با هوش مصنوعی خونده بشه. ` +
  `این کار حدود ${minutes} دقیقه طول می‌کشه و تا تموم نشه، جواب سؤال‌هات هم کندتر می‌رسه.` +
  (skipped > 0
    ? `\n⚠️ ${skipped} صفحه دیگه به‌خاطر محدودیت تعداد صفحه خونده نمی‌شه.`
    : "");

export const uploadInterruptedText = (filename: string): string =>
  `⚠️ پردازش فایل «${filename}» به‌خاطر راه‌اندازی دوباره ربات نیمه‌کاره موند. لطفاً دوباره بفرستش.`;

/** An answer stopped because the bot is restarting; the inbox answers it after the restart. */
export const RESTARTING_TEXT = "🔄 ربات داره دوباره راه‌اندازی می‌شه؛ جوابت چند لحظه دیگه میاد.";

/** A message the bot could not answer (a restart or repeated failures) and will not answer late. */
export const MESSAGE_NOT_ANSWERED_TEXT =
  "⚠️ به پیام قبلیت به‌خاطر یه مشکل یا راه‌اندازی دوباره ربات نتونستم جواب بدم. لطفاً دوباره بفرستش.";

export const ocrProgressText = (done: number, total: number): string =>
  `⏳ خوندن صفحه‌ها: ${done} از ${total}`;

export const fileProcessedText = (ocrPages: number): string =>
  `✅ جزوه‌ات آماده‌ست.\n\n` +
  `حالا می‌تونی درباره‌ش سؤال بپرسی؛ جواب سؤال‌هات رو از همه جزوه‌هات پیدا می‌کنم.\n\n` +
  `📚 برای دیدن جزوه‌هات، دکمه زیر رو بزن.` +
  (ocrPages > 0 ? `\n\n🔍 ${ocrPages} صفحه با تشخیص متن خونده شد.` : "");

// --- Chatting ------------------------------------------------------------------

export const CANCEL_BUTTON = "⏹️ لغو";

export const THINKING_NOTICE_TEXT =
  "⏳ دارم سؤالت رو بررسی می‌کنم و جواب رو آماده می‌کنم...\n\n" +
  `برای توقف، دکمه «${CANCEL_BUTTON}» رو بزن.`;


/** The thinking notice once the answer is sent (no stale "press cancel" line). */
export const THINKING_DONE_TEXT = "✅ جوابت آماده شد 👇";

export const REQUEST_CANCELLED_TEXT = "⏹️ درخواستت لغو شد.";

export const NO_REQUEST_TO_CANCEL_TEXT =
  "الان درخواستی در حال انجام نیست که لغو کنم.";

// --- Answers from documents ---------------------------------------------------

export const NO_DOCUMENT_CONTENT_TEXT =
  "توی جزوه‌هات محتوایی پیدا نکردم.";

export const NO_RELEVANT_CONTENT_TEXT =
  "توی جزوه‌هات چیز مرتبطی با سؤالت پیدا نکردم.";

/** After an answer the output cap cut off mid-way. */
export const ANSWER_CUT_TEXT =
  "✂️ جواب خیلی طولانی شد و همین‌جا قطع شد. اگه بقیه‌اش رو می‌خوای، سؤالت رو جزئی‌تر بپرس.";

/** First line of a summary: the bot picked the document, so it says which. */
export const summaryHeaderText = (filename: string): string => `📄 خلاصه «${filename}»:`;

export const documentInfoHeaderText = (filename: string): string => `📄 درباره «${filename}»:`;

export const SOURCES_HEADING = "**منابع:**";

/** First-strong isolate … pop directional isolate (invisible). */
const FSI = "⁨";
const PDI = "⁩";

/**
 * A file name inside Persian text: without ".pdf", and isolated so a Latin
 * name keeps its own direction (otherwise "chapter.pdf — صفحه 12" shows as
 * "12 صفحه — pdf.chapter", roadmap 2.4).
 */
const isolatedFilename = (filename: string): string => `${FSI}${String(filename).replace(/\.pdf$/i, "")}${PDI}`;

export const sourceLineText = (
  filename: string,
  pageNumber: number,
  pageEnd?: number | null,
): string =>
  pageEnd && pageEnd > pageNumber
    ? `${isolatedFilename(filename)} — صفحه ${pageNumber} تا ${pageEnd}`
    : `${isolatedFilename(filename)} — صفحه ${pageNumber}`;

// --- Feedback on answers ---------------------------------------------------------

export const FEEDBACK_GOOD_BUTTON = "👍 مفید بود";
export const FEEDBACK_BAD_BUTTON = "👎 مفید نبود";

export const FEEDBACK_THANKS_TEXT = "ممنون از بازخوردت! 🙏";

export const FEEDBACK_SORRY_TEXT =
  "ممنون که گفتی. این جواب رو بررسی می‌کنیم تا دفعه بعد بهتر جواب بدم.";

export const FEEDBACK_FAILED_TEXT = "این بازخورد ثبت نشد.";

// --- Errors ------------------------------------------------------------------

export const SAVE_MESSAGE_FAILED_TEXT =
  "نتونستم پیامت رو ذخیره کنم. لطفاً کمی بعد دوباره امتحان کن.";

export const PROCESSING_FAILED_TEXT =
  "ببخشید، موقع پردازش پیامت مشکلی پیش اومد. لطفاً کمی بعد دوباره امتحان کن.";

export const FILE_TIMEOUT_TEXT =
  "پردازش فایل بیش از حد طول کشید. لطفاً کمی بعد دوباره امتحان کن.";

export const AI_UNAVAILABLE_TEXT =
  "سرویس هوش مصنوعی الان در دسترس نیست. لطفاً کمی بعد دوباره امتحان کن.";

export const FILE_UNREADABLE_TEXT =
  "نتونستم متن این فایل رو بخونم. مطمئن شو فایل سالمه و متنش واضحه، بعد دوباره بفرستش.";

export const FILE_PROCESSING_FAILED_TEXT =
  "پردازش فایل با خطا مواجه شد. لطفاً کمی بعد دوباره امتحان کن.";
