// Unit tests for the island's pure logic (npm run test:unit). They run in plain
// Node with the Tauri bridge mocked — see TESTING.md. The end-to-end suite has
// its own config, vitest.e2e.config.ts.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
