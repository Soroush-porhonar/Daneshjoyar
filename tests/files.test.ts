import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeUploadedFile, storedFilePath } from "../src/files.js";
import { logger } from "../src/logger.js";

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "files-test-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("uploaded files", () => {
  it("stores paths relative to the working directory, with forward slashes", () => {
    expect(storedFilePath(path.join(dir, "uploads", "1-a.pdf"))).toBe("uploads/1-a.pdf");
  });

  it("removes a stored file", async () => {
    await writeFile(path.join(dir, "a.pdf"), "x");

    await removeUploadedFile("a.pdf");

    expect(existsSync(path.join(dir, "a.pdf"))).toBe(false);
  });

  it("is quiet about a file already gone, or none recorded", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await removeUploadedFile("missing.pdf");
    await removeUploadedFile(null);

    expect(warn).not.toHaveBeenCalled();
  });
});
