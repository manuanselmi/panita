// Unit tests for the island's pure logic (npm run test:unit). They run in plain
// Node with the Tauri bridge mocked — see TESTING.md. The end-to-end suite has
// its own config, vitest.e2e.config.ts.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The companion VS Code extension imports `vscode`, which only exists
    // inside VS Code: its tests get a small stand-in instead.
    alias: { vscode: fileURLToPath(new URL("./tests/unit/vscode-mock.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
