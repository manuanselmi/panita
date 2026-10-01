// Builds the companion VS Code extension (vscode-extension/) and packages it as
// vscode-extension/dist/coucou-terminal-focus.vsix, which the app ships as a
// Tauri resource and installs into VS Code only when the user clicks Install
// in Settings → Claude Code. Run by `prebuild`, `predev` and `test:rust` (the
// app's build script checks that every bundled resource exists).
//
// The extension has no dependencies of its own: it is compiled with this
// package's TypeScript and packaged with this package's @vscode/vsce.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "vscode-extension");
const vsix = join(extension, "dist", "coucou-terminal-focus.vsix");
const require = createRequire(import.meta.url);

rmSync(join(extension, "out"), { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", extension], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

mkdirSync(dirname(vsix), { recursive: true });
const { createVSIX } = require("@vscode/vsce");
await createVSIX({
  cwd: extension,
  packagePath: vsix,
  // Zero runtime dependencies: nothing to look up with npm.
  dependencies: false,
  // A private fork: no public repository or separate licence file to point at
  // (the manifest says MIT, like the rest of the repository).
  allowMissingRepository: true,
  skipLicense: true,
});
