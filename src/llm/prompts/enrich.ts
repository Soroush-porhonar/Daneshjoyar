/**
 * Prompts for upload-time enrichment (src/rag/enrich.ts). Outputs are stored
 * and reused for every later question, so they must stay faithful to the text.
 */

/** User prompt for one section summary (system prompt: BROAD_EXTRACTION_SYSTEM_PROMPT). */
export function buildSectionSummaryPrompt(context: string): string {
  return `<متن این بخش از PDF>
${context}
</متن این بخش از PDF>

مطالب این بخش را برای مرور درسی خلاصه کن: همه مفاهیم، تعریف‌ها، دسته‌بندی‌ها، مراحل، فرمول‌ها و مثال‌های مهم را نگه دار و کنار هر نکته شماره صفحه PDF آن را مطابق برچسب‌ها بیاور. سؤال‌ها یا تمرین‌های داخل متن را حل نکن.`;
}

export const PROFILE_SYSTEM_PROMPT = `تو برای جزوه‌های درسی شناسنامه می‌سازی.
از روی خلاصه بخش‌های یک جزوه بنویس:
- title: یک عنوان کوتاه و گویای فارسی که موضوع جزوه را بگوید (مثلاً «هوش مصنوعی و سیستم‌های خبره»)، نه نام فایل.
- summary: سه یا چهار جمله فارسی درباره اینکه جزوه چه مطالبی را پوشش می‌دهد.
- topics: پنج تا ده مبحث اصلی جزوه، هر کدام چند کلمه.
فقط از اطلاعات خلاصه‌ها استفاده کن.`;

export function buildProfilePrompt(filename: string, summaries: string[]): string {
  return `نام فایل: ${filename}

<خلاصه بخش‌های جزوه>
${summaries.join("\n\n---\n\n")}
</خلاصه بخش‌های جزوه>`;
}

export const CHUNK_CONTEXT_SYSTEM_PROMPT = `تو به جست‌وجو در جزوه‌های درسی کمک می‌کنی.
برای یک تکه از جزوه بنویس:
- context: یک جمله فارسی که بگوید این تکه از کدام جزوه و کدام مبحث است و درباره چیست؛ طوری که بدون دیدن بقیه جزوه معلوم باشد «این» و «آن» در متن به چه اشاره دارند.
- questions: دو یا سه سؤال کوتاه فارسی که یک دانشجو ممکن است بپرسد و جوابشان در همین تکه است، با کلمات خود دانشجو (نه کپی جمله‌های متن).
فقط از همین تکه و توضیح جزوه استفاده کن و چیزی اضافه نکن.`;

export function buildChunkContextPrompt(title: string, sectionSummary: string, chunk: string): string {
  return `جزوه: ${title}

<خلاصه این بخش از جزوه>
${sectionSummary}
</خلاصه این بخش از جزوه>

<تکه>
${chunk}
</تکه>`;
}
