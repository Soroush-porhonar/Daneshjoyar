import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Need a real database: npm run test:integration
    exclude: ["tests/integration/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text", "html"],
    },
    env: {
      PORT: "3000",
      BALE_TOKEN: "test-token",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      LLM_URL: "http://localhost:11434/api/chat",
      LLM_MODEL: "test-model",
      EMBEDDING_MODEL: "test-embed",
      // Unit tests never call the real reranker service.
      RERANKER_ENABLED: "false",
      // Nor message a real admin chat (tests/alerts.test.ts sets one itself).
      ADMIN_CHAT_ID: "",
    },
  },
});
