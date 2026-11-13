import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));

const { checkReadiness } = await import("../src/readiness.js");
const { pool } = await import("../src/db/pool.js");
const { config } = await import("../src/config.js");

const reranker = config.reranker as { enabled: boolean };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
  reranker.enabled = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  reranker.enabled = false; // the unit-test default (vitest.config.ts)
});

describe("readiness", () => {
  it("is ready when the database, Ollama and the reranker answer", async () => {
    expect(await checkReadiness()).toEqual({ ready: true, checks: { database: "ok", ollama: "ok", reranker: "ok" } });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith("/api/version"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/health"))).toBe(true);
  });

  it("is not ready when Ollama is down", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/api/version") ? Promise.reject(new Error("ECONNREFUSED")) : new Response("{}"),
    );

    expect(await checkReadiness()).toMatchObject({ ready: false, checks: { ollama: "down" } });
  });

  it("is not ready when the reranker answers with an error", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new Response("{}", { status: String(url).endsWith("/health") ? 503 : 200 }),
    );

    expect(await checkReadiness()).toMatchObject({ ready: false, checks: { reranker: "down" } });
  });

  it("is not ready when the database fails", async () => {
    vi.mocked(pool.query).mockRejectedValue(new Error("password authentication failed"));

    expect(await checkReadiness()).toMatchObject({ ready: false, checks: { database: "down" } });
  });

  it("does not need a disabled reranker", async () => {
    reranker.enabled = false;

    expect(await checkReadiness()).toEqual({ ready: true, checks: { database: "ok", ollama: "ok", reranker: "off" } });
  });
});
