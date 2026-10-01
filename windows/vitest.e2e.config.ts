// End-to-end suite (npm run test:e2e): builds the app, runs it as the side
// instance COUCOU_INSTANCE=e2e and drives it through the real relay and CDP.
// See TESTING.md.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    globalSetup: ["tests/e2e/global-setup.ts"],
    environment: "node",
    // One app, one island: never two files at once.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
