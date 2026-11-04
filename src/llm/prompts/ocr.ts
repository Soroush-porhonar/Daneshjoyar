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

/** Strip variants: a tall page is read in horizontal strips (src/rag/pageImage.ts). */
export const OCR_STRIP_PROMPT =
  "This image is one horizontal strip of a page. Transcribe all the text in it exactly as written, " +
  "in its original language (Persian or English), including lines cut at the top or bottom edge. " +
  "Keep code, formulas and numbers exact. Output only the transcribed text, with no commentary.";

export const OCR_STRIP_PROMPT_FA =
  "این تصویر یک نوار افقی از یک صفحه است. متن آن را دقیقاً همان‌طور که نوشته شده، به همان زبان (فارسی یا انگلیسی) بنویس، " +
  "حتی خط‌هایی که لبه بالا یا پایین تصویر آن‌ها را بریده است. " +
  "حروف هر کلمه فارسی را به ترتیب درست بنویس؛ هیچ کلمه‌ای را برعکس ننویس. " +
  "کد، فرمول و عددها را دقیق نگه دار. چیزی را اصلاح، خلاصه یا ترجمه نکن و فقط متن تصویر را بنویس.";
