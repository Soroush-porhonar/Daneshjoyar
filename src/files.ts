/** Uploaded files on disk (uploads/), stored by path relative to the working directory. */
import path from "node:path";
import { unlink } from "node:fs/promises";
import { logger } from "./logger.js";

/**
 * The path stored on the document row for a downloaded file, always with "/"
 * (the bot runs on Linux in Docker and on Windows with npm run dev).
 */
export const storedFilePath = (absolutePath: string): string =>
  path.relative(process.cwd(), absolutePath).split(path.sep).join("/");

/**
 * Removes an uploaded file. A file already gone is fine; any other failure is
 * logged, never thrown (the database rows are already deleted).
 */
export async function removeUploadedFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  try {
    await unlink(path.resolve(process.cwd(), filePath));
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return;
    logger.warn("Could not remove an uploaded file:", { filePath, error });
  }
}
