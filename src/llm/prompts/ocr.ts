export const OCR_PROMPT =
  "Transcribe all the text on this page exactly as written, in its original language (Persian or English). " +
  "Keep code, formulas and numbers exact. Output only the transcribed text, with no commentary.";

/**
 * The same request in Persian, adding what the model got wrong on scanned
 * notes: words written with their letters reversed («هب» for «به»).
 */
export const OCR_PROMPT_FA =
  "متن این صفحه را دقیقاً همان‌طور که نوشته شده، به همان زبان (فارسی یا انگلیسی) بنویس. " +
  "حروف هر کلمه فارسی را به ترتیب درست بنویس؛ هیچ کلمه‌ای را برعکس ننویس. " +
  "کد، فرمول و عددها را دقیق نگه دار. چیزی را اصلاح، خلاصه یا ترجمه نکن و فقط متن صفحه را بنویس.";
