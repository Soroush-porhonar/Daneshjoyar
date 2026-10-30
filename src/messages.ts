/**
 * Every text the user can see, in one place.
 *
 * Style guide (keep new messages consistent with it):
 * - Persian only; the only Latin text allowed is "PDF" and command names.
 * - Friendly, informal "تو" voice (می‌تونی، بفرست، دوباره امتحان کن).
 * - Bold (**...**) only for section titles; one emoji at the start of a section.
 * - Commands are always written with cmd(), e.g. cmd("/select 3").
 * - Buttons do the common actions; typed commands keep working.
 */
import type { DocumentStatus } from "./db/documents.js";

/** Left-to-right mark (invisible). */
const LRM = "‎";

/**
 * A command as shown to users. Inside right-to-left Persian text, clients
 * reorder "/select 3" into "3 /select"; the marks keep it in order.
 */
const cmd = (command: string): string => `${LRM}${command}${LRM}`;

// --- Main menu (keyboard at the bottom of the chat) ---------------------------

export const MENU_DOCUMENTS = "📚 جزوه‌های من";
export const MENU_HELP = "❓ راهنما";
export const MENU_ABOUT = "ℹ️ درباره";

export const MAIN_MENU: string[][] = [
  [MENU_DOCUMENTS],
  [MENU_HELP, MENU_ABOUT],
];

// --- Info commands -----------------------------------------------------------

export const START_TEXT = `سلام! 👋 به دانشجویار خوش اومدی.

🎓 من دستیار هوشمند مطالعه‌ات هستم. جزوه‌هات رو به‌صورت PDF برام بفرست تا بتونی درباره‌شون ازم سؤال بپرسی.

📌 **برای شروع:**
۱. فایل PDF جزوه‌ات رو بفرست.
۲. صبر کن تا پردازش فایل تموم بشه.
۳. سؤالت رو بپرس تا بر اساس جزوه جوابت رو بدم.

از دکمه‌های پایین صفحه هم می‌تونی جزوه‌هات و راهنما رو ببینی.

یادگیری بهتر، قدم‌به‌قدم! 🌱`;

export const HELP_TEXT = `📚 **راهنمای دانشجویار**

من بهت کمک می‌کنم راحت‌تر درس بخونی و جواب سؤال‌هات رو از روی جزوه‌هات پیدا کنی.

**چطور ازم استفاده کنی؟**

📄 **۱. فرستادن جزوه**
یک فایل PDF بفرست. بعد از پردازش، خودکار به‌عنوان سند فعال انتخاب می‌شه. اگه فایل اسکن‌شده باشه، پردازشش چند دقیقه طول می‌کشه.

💬 **۲. پرسیدن سؤال**
سؤالت رو درباره سند فعال بپرس. لازم نیست هر بار فایل رو دوباره انتخاب کنی. زیر هر جواب با 👍 یا 👎 بگو مفید بود یا نه.

📚 **۳. مدیریت جزوه‌ها**
دکمه «${MENU_DOCUMENTS}» رو بزن؛ زیر فهرست، برای انتخاب یا حذف هر جزوه دکمه هست.

🌐 **۴. سؤال‌های عمومی**
اگه سؤالت به جزوه‌هات ربطی نداشته باشه، مثل یک دستیار هوشمند معمولی جوابت رو می‌دم.


💡 **نکته:** هر PDF جدیدی که با موفقیت پردازش بشه، خودکار سند فعال می‌شه.`;

export const ABOUT_TEXT = `🎓 **دانشجویار** | دستیار هوشمند مطالعه

دانشجویار یک دستیار مطالعه در پیام‌رسان بله است که با کمک هوش مصنوعی، مرور و فهمیدن مطالب درسی رو راحت‌تر می‌کنه.

✨ **امکانات فعلی:**
📄 دریافت و پردازش فایل‌های PDF (حتی اسکن‌شده)
💬 جواب دادن به سؤال‌های درسی از روی جزوه‌هات
📚 دیدن و انتخاب جزوه‌ها
🗑️ حذف جزوه‌های ذخیره‌شده
⏹️ لغو درخواست‌های در حال انجام

دانشجویار هنوز در حال توسعه‌ست و مدام بهتر می‌شه.

یادگیری بهتر، قدم‌به‌قدم! 🌱`;

// --- Documents ---------------------------------------------------------------

export const DOCUMENT_STATUS_TEXT: Record<DocumentStatus, string> = {
  pending: "در انتظار پردازش",
  processing: "در حال پردازش",
  completed: "آماده مطالعه",
  failed: "پردازش ناموفق",
};

export const NO_DOCUMENTS_TEXT =
  "هنوز هیچ جزوه‌ای نفرستادی.\n\nبرای شروع، یک فایل PDF برام بفرست. 📄";

/** Button labels under the documents list (one row per document). */
export const SELECT_BUTTON = "📌 انتخاب";
export const ACTIVE_BUTTON = "✅ فعال";
export const DELETE_BUTTON = "🗑️ حذف";

/** The document's name on its button: ✅ active, ⏳ still processing, ⚠️ failed. */
export const documentNameButton = (
  name: string,
  status: DocumentStatus,
  active: boolean,
): string => {
  const icon = active
    ? "✅"
    : status === "failed"
      ? "⚠️"
      : status === "completed"
        ? "📄"
        : "⏳";
  return `${icon} ${name}`;
};

/** Popup when a document's name is tapped (names on buttons are shortened). */
export const documentInfoText = (
  filename: string,
  status: DocumentStatus,
  active: boolean,
): string =>
  `${filename}\nوضعیت: ${DOCUMENT_STATUS_TEXT[status]}${active ? " — سند فعال" : ""}`;

export const DOCUMENTS_LIST_TEXT =
  `📚 **جزوه‌های تو**\n\n` +
  `📌 **سند فعال** جزوه‌ایه که سؤال‌هات از روی اون جواب داده می‌شه؛ کنار اسمش ✅ می‌بینی. ` +
  `هر PDF جدیدی که بفرستی، بعد از پردازش خودکار سند فعال می‌شه.\n\n` +
  `👇 برای فعال کردن یک جزوه «${SELECT_BUTTON}» و برای پاک کردنش «${DELETE_BUTTON}» رو بزن.`;

export const SELECT_USAGE_TEXT = `شناسه جزوه رو این‌طوری وارد کن:\n${cmd("/select 1")}`;

export const SELECT_FAILED_TEXT = `این جزوه پیدا نشد، هنوز پردازشش تموم نشده یا مال تو نیست. فهرست جزوه‌ها: ${cmd("/documents")}`;

export const selectedText = (documentId: number): string =>
  `✅ جزوه شماره ${documentId} به‌عنوان سند فعال انتخاب شد. حالا می‌تونی سؤالت رو بپرسی.`;

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

// --- Uploading a PDF -----------------------------------------------------------

export const NOT_A_PDF_TEXT =
  "فقط فایل PDF قبول می‌کنم. لطفاً جزوه‌ات رو با فرمت PDF بفرست.";

export const FILE_TOO_LARGE_TEXT =
  "حجم فایل بیشتر از ۲۰ مگابایته. لطفاً فایل کوچک‌تری بفرست.";

/** The same file (name and size) was already uploaded by this user. */
export const duplicateDocumentText = (filename: string, stillProcessing: boolean): string =>
  stillProcessing
    ? `📎 فایل «${filename}» رو قبلاً فرستادی و الان در حال پردازشه. یه کم صبر کن تا آماده بشه.`
    : `📎 فایل «${filename}» رو قبلاً فرستادی و توی جزوه‌هات هست، پس دوباره ذخیره‌ش نکردم.\n\n` +
      `اگه می‌خوای ازش سؤال بپرسی، از دکمه زیر انتخابش کن.`;

export const FILE_RECEIVED_TEXT =
  "📥 فایلت رسید. دارم پردازشش می‌کنم، یه کم صبر کن...";

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

export const ocrProgressText = (done: number, total: number): string =>
  `⏳ خوندن صفحه‌ها: ${done} از ${total}`;

export const fileProcessedText = (ocrPages: number): string =>
  `✅ جزوه‌ات آماده‌ست و به‌عنوان **سند فعال** انتخاب شد.\n\n` +
  `حالا می‌تونی مستقیم درباره‌ش سؤال بپرسی.\n\n` +
  `📚 برای دیدن جزوه‌های قبلی یا عوض کردن سند فعال، دکمه زیر رو بزن.` +
  (ocrPages > 0 ? `\n\n🔍 ${ocrPages} صفحه با تشخیص متن خونده شد.` : "");

// --- Chatting ------------------------------------------------------------------

export const CANCEL_BUTTON = "⏹️ لغو";

export const THINKING_NOTICE_TEXT =
  "⏳ دارم سؤالت رو بررسی می‌کنم و جواب رو آماده می‌کنم...\n\n" +
  `برای توقف، دکمه «${CANCEL_BUTTON}» رو بزن.`;

export const REQUEST_CANCELLED_TEXT = "⏹️ درخواستت لغو شد.";

export const NO_REQUEST_TO_CANCEL_TEXT =
  "الان درخواستی در حال انجام نیست که لغو کنم.";

// --- Answers from documents ---------------------------------------------------

export const NO_DOCUMENT_SELECTED_TEXT =
  "هنوز جزوه‌ای برای مطالعه انتخاب نکردی.\n\n" +
  `دکمه «${MENU_DOCUMENTS}» رو بزن و جزوه‌ای که می‌خوای رو انتخاب کن.`;

export const NO_DOCUMENT_CONTENT_TEXT =
  "توی جزوه انتخاب‌شده محتوایی پیدا نکردم.";

export const NO_RELEVANT_CONTENT_TEXT =
  "توی جزوه انتخاب‌شده چیز مرتبطی با سؤالت پیدا نکردم.";

export const SOURCES_HEADING = "**منابع:**";

export const sourceLineText = (
  filename: string,
  pageNumber: number,
  pageEnd?: number | null,
): string =>
  pageEnd && pageEnd > pageNumber
    ? `${filename} — صفحه ${pageNumber} تا ${pageEnd}`
    : `${filename} — صفحه ${pageNumber}`;

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

export const PDF_UNREADABLE_TEXT =
  "نتونستم فایل PDF رو بخونم. مطمئن شو فایل سالمه و دوباره بفرستش.";

export const FILE_PROCESSING_FAILED_TEXT =
  "پردازش فایل با خطا مواجه شد. لطفاً کمی بعد دوباره امتحان کن.";
