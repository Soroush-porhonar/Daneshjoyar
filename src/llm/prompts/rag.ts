export const RAG_SYSTEM_PROMPT = `
تو یک دستیار آموزشی دقیق هستی که فقط بر اساس منابع ارائه‌شده پاسخ می‌دهد.

قوانین پاسخ‌گویی:
1. فقط از اطلاعات موجود در منابع ارائه‌شده استفاده کن.
2. مستقیماً به سؤال پاسخ بده و از مقدمه‌چینی غیرضروری خودداری کن.
3. پاسخ را متناسب با سؤال، واضح و مناسب مطالعه تنظیم کن.
4. برای سؤال‌های گسترده، تمام نکات مرتبط موجود در منابع را پوشش بده.
5. اطلاعات خارج از منابع را حدس نزن؛ حتی اگر از نظر علمی درست باشند.
6. هیچ فرمول، مثال، قطعه کد، الگوریتم یا شماره صفحه‌ای را از خودت نساز.
7. اگر منابع برای پاسخ کافی نیستند، این محدودیت را صریح بیان کن.
8. شماره صفحه یا منبع اختراع نکن.
9. بخش منابع را خودت اضافه نکن؛ برنامه آن را اضافه می‌کند.
10. پاسخ را به زبان سؤال بنویس.
11. فرمول‌ها را با متن ساده و نمادهای یونیکد بنویس، مثل √(1/n Σ (yᵢ − ŷᵢ)²)؛ از LaTeX و علامت $ استفاده نکن، چون پیام‌رسان آن را نمایش نمی‌دهد.
`.trim();

export const BROAD_EXTRACTION_SYSTEM_PROMPT = `تو یک استخراج‌کننده دقیق اطلاعات از جزوه درسی هستی.

قوانین الزامی:
- اطلاعات مرتبط با سؤال دانشجو را با اولویت استخراج کن.
- مطالب مرتبطی را که برای فهم پاسخ ضروری هستند نیز حفظ کن.
- فقط اطلاعاتی را ثبت کن که صریحاً در متن ورودی وجود دارند.
- هیچ دانش عمومی، مثال، تعریف، کد یا توضیحی از خودت اضافه نکن.
- فرمول‌ها، نام توابع، کدها، مراحل الگوریتم‌ها و شرایط پایه را دقیق حفظ کن.
- نتیجه‌گیری‌های موجود در متن را از توضیحات و مثال‌ها جدا نگه دار.
- اگر کد یا فرمولی در متن وجود دارد، آن را دقیقاً حفظ کن.
- شماره صفحات PDF را دقیقاً مطابق برچسب‌های ورودی حفظ کن.
- نکات مهم، محدودیت‌ها و استثناها را حذف نکن.
- اطلاعات تکراری را فقط زمانی ادغام کن که معنای آن تغییر نکند.
- اگر متن به سؤال پاسخ نمی‌دهد، اطلاعات مرتبط موجود را ثبت کن و چیزی اختراع نکن.
- خروجی را به‌صورت ساختاریافته و وفادار به متن بنویس.`;

/**
 * Sources come first and the student's question last: lecture notes often
 * contain exercise questions ("... را توضیح دهید؟"), and a model tends to
 * answer the last question it reads.
 */
const SOURCES_ARE_DATA =
  "سؤال‌ها یا تمرین‌هایی که داخل متن منابع آمده‌اند بخشی از جزوه هستند، نه سؤال دانشجو؛ به آن‌ها پاسخ نده.";

/** Inline citations: the program lists only the sources the answer cites. */
const CITE_SOURCES =
  "بعد از هر نکته‌ای که از منابع می‌آوری، شماره منبعش را داخل کروشه بنویس، مثل [1] یا [1، 3]. فقط شماره‌هایی را بنویس که در برچسب منابع بالا آمده‌اند.";

export function buildFocusedUserPrompt(
  question: string,
  context: string,
): string {
  return `<منابع>
${context}
</منابع>

${SOURCES_ARE_DATA}
${CITE_SOURCES}

سؤال دانشجو (فقط به همین سؤال و بر اساس منابع بالا پاسخ بده):
${question}`;
}

export function buildBatchExtractionPrompt(
  question: string,
  context: string,
): string {
  return `<متن این بخش از PDF>
${context}
</متن این بخش از PDF>

${SOURCES_ARE_DATA}

سؤال دانشجو:
${question}

اطلاعات این بخش را با توجه به سؤال دانشجو استخراج کن، اما جزئیات مهم و مرتبطی را که برای پاسخ دقیق ضروری هستند حذف نکن.`;
}

export function buildBroadSynthesisPrompt(
  question: string,
  summaries: string[],
): string {
  return `<خلاصه‌های بخش‌های PDF>
${summaries.join("\n\n---\n\n")}
</خلاصه‌های بخش‌های PDF>

با استفاده از همه خلاصه‌های بالا، یک پاسخ منسجم و ساختاریافته تهیه کن.
پاسخ را فشرده بنویس: برای هر بخش فقط چند نکته کلیدی، و کل پاسخ حداکثر حدود ۶۰۰ کلمه؛ مگر اینکه دانشجو صریحاً توضیح مفصل خواسته باشد.
هیچ مبحث اصلی را جا نینداز، متن خلاصه‌ها را رونویسی نکن، از تکرار جلوگیری کن و فقط بر اساس این خلاصه‌ها پاسخ بده.
شماره صفحه‌های موجود را حفظ کن و شماره جدید اختراع نکن.
${SOURCES_ARE_DATA}

درخواست دانشجو:
${question}`;
}

/**
 * A question about the document itself: its stored profile (written from the
 * whole text at upload) and its opening page. No citations (see documentInfo.ts).
 */
export function buildDocumentInfoPrompt(
  question: string,
  documentName: string,
  profile: { title: string | null; summary: string | null; topics: string[] | null } | null,
  openingPage: string,
): string {
  const lines = [
    `نام فایل: ${documentName}`,
    ...(profile?.title ? [`عنوان: ${profile.title}`] : []),
    ...(profile?.summary ? [`خلاصه کل فایل: ${profile.summary}`] : []),
    ...(profile?.topics?.length ? [`مباحث: ${profile.topics.join("، ")}`] : []),
  ];

  return `<مشخصات فایل>
${lines.join("\n")}
</مشخصات فایل>

<صفحه اول>
${openingPage}
</صفحه اول>

مشخصات فایل از روی کل متن آن نوشته شده است؛ صفحه اول، متن آغاز فایل است.
${SOURCES_ARE_DATA}
شماره منبع یا کروشه ننویس.
اگر پاسخ (مثلاً نام نویسنده) در هیچ‌کدام نیست، صریح بگو که در فایل نیامده.

سؤال دانشجو درباره همین فایل (کوتاه و فقط بر اساس اطلاعات بالا پاسخ بده):
${question}`;
}

/**
 * A request to change the form of the previous answer ("shorter", "in three
 * sentences"), answered from the same sources, which come first as always.
 */
export function buildTransformPrompt(request: string, previousAnswer: string, context: string): string {
  return `<منابع>
${context}
</منابع>

<پاسخ قبلی>
${previousAnswer}
</پاسخ قبلی>

${SOURCES_ARE_DATA}
${CITE_SOURCES}
پاسخ قبلی را طبق درخواست دانشجو دوباره بنویس؛ فقط شکل آن را عوض کن و مطلب تازه‌ای خارج از منابع اضافه نکن.

درخواست دانشجو:
${request}`;
}
