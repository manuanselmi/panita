// Runs once in vitest's main process, around the whole end-to-end suite:
// build (or reuse) the binaries and refuse old ones, then — whatever happened in
// the test worker — make sure no side instance or side folder is left behind.

import fs from "node:fs";
import {
  APP_EXE,
  HOOK_EXE,
  INSTANCE,
  RESULTS_DIR,
  assertKnowsInstances,
  buildAll,
  removeSideDirs,
  stopLeftoverFromPidFile,
} from "./harness";

export default function setup() {
  if (process.platform !== "win32") throw new Error("the end-to-end suite drives the Windows app; run it on Windows");

  const leftover = stopLeftoverFromPidFile();
  if (leftover) console.log(`[e2e] ${leftover}`);
  // Fresh screenshots and logs every run, so nothing in there is from last time.
  fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (process.env.COUCOU_E2E_SKIP_BUILD === "1") {
    console.log("[e2e] COUCOU_E2E_SKIP_BUILD=1 — reusing target/debug/coucou.exe and target/release/coucou-hook.exe");
  } else {
    console.log("[e2e] building the app (debug, front end embedded) and the relay — first run takes a few minutes");
    const { seconds, logFile } = buildAll();
    console.log(`[e2e] built in ${seconds} s (${logFile})`);
  }
  assertKnowsInstances(APP_EXE);
  assertKnowsInstances(HOOK_EXE);
  console.log(`[e2e] side instance: COUCOU_INSTANCE=${INSTANCE}`);

  return function teardown() {
    // Normally the suite has already done both; this is the net under it.
    const stopped = stopLeftoverFromPidFile();
    if (stopped) console.log(`[e2e] ${stopped}`);
    try {
      removeSideDirs();
    } catch (err) {
      console.warn(`[e2e] could not remove the side instance's folders: ${String(err)}`);
    }
  };
}
