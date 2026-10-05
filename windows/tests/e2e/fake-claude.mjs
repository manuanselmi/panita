// A stand-in for Claude Code in `-p --input-format stream-json` mode, for the
// end-to-end suite's chat cases. The harness puts it first on the side
// instance's PATH as `claude.cmd` (FAKE_CLAUDE), so the island's chat starts
// this instead of the real `claude` — no account, no network, nothing spent.
//
// It records how it was started and every message it gets in
// claude-calls.jsonl, next to itself, and answers each message with an echo
// that names its process, its turn and its session, so a test can tell a
// message answered by the same process from one answered by a new one:
//
//   eco: <last line of the message> · pid <pid> · turno <n> · sesión <id>
//
// A message containing "morite" makes it exit at once, without answering (a
// crash); one containing "fallá" gets an error result (a turn that fails while
// the process lives on).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const record = (entry) =>
  fs.appendFileSync(path.join(here, "claude-calls.jsonl"), JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const session = flag("--session-id") ?? flag("--resume");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");

record({ event: "start", args, cwd: process.cwd() });

let turn = 0;
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    const text = message.message.content.map((block) => block.text).join("");
    turn += 1;
    record({ event: "message", session, text });
    if (turn === 1) out({ type: "system", subtype: "init", session_id: session, model: "fake" });
    if (text.includes("morite")) {
      record({ event: "crash" });
      process.exit(3);
    }
    if (text.includes("fallá")) {
      out({ type: "result", subtype: "success", is_error: true, result: "Fake failure", session_id: session });
      return;
    }
    const answer = `eco: ${text.split("\n").pop()} · pid ${process.pid} · turno ${turn} · sesión ${session}`;
    out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
    out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: session });
  })
  .on("close", () => {
    // stdin closed: what Claude Code does when the app quits or lets it go.
    record({ event: "exit" });
    process.exit(0);
  });
