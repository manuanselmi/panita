// Real-input checks (npm run test:input). MOVES THE MOUSE — opt-in with
// COUCOU_ALLOW_REAL_INPUT=1, idle desktop only. See tests/input/ and TESTING.md.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/input/**/*.input.ts"],
    globalSetup: ["tests/e2e/global-setup.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
