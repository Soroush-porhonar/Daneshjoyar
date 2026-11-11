import path from "node:path";

/** What an uploaded file is: a PDF, or a photo of a page (JPEG, PNG, WebP). */
export type DocumentKind = "pdf" | "image";

/** Image formats the decoder reads (src/rag/image.ts); HEIC, for one, it does not. */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/** A stored document is a photo when its name ends like one (a PostgreSQL regex, case-insensitive with ~*). */
export const PHOTO_FILENAME_PATTERN = "\.(jpe?g|png|webp)$";

/** A PDF, a photo, or (null) a file that can't be read, judged by its name or MIME type. */
export function documentKind(filename = "", mimeType = ""): DocumentKind | null {
  const extension = path.extname(filename).toLowerCase();

  if (extension === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(extension) || IMAGE_TYPES.includes(mimeType)) return "image";
  return null;
}

export const isPhotoFilename = (filename: string | null | undefined): boolean =>
  documentKind(filename ?? "") === "image";
