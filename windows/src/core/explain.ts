// What a command does, in one short line of Spanish — shown under the command
// on the approval card, so "Allow" is a decision about an action rather than
// about a string of shell.
//
//   git push origin main:dev              → Push de "main" a "dev"
//   cd ../x && git commit -m "fix"        → Moverse a "x" → Commit en "dev": "fix"
//   rm -rf build                          → ⚠ Eliminar "build" y todo su contenido
//   Write · C:\repo\src\x.ts              → Escribir el archivo "x.ts"
//
// HOW IT WORKS
//
// 1. The command line is cut into simple commands at `&&`, `||`, `;`, `|`, `&`
//    and line breaks — never inside quotes, `$( … )` or a heredoc's text.
// 2. Each simple command is matched against RULES, top to bottom; the first
//    rule that has something to say wins. A command no rule knows is skipped.
// 3. The known parts are joined in order with " → ". If nothing is known there
//    is no line at all: better no explanation than a wrong one.
//
// HOW TO ADD A RULE
//
// Add an entry to RULES — above any more general rule for the same program —
// and a case to tests/unit/explain.test.ts. The simplest rules are data:
//
//   { cmd: "git stash pop", say: "Recuperar los cambios guardados en el stash" },
//   { cmd: "kubectl apply", values: ["-f"], say: "Aplicar {-f:base} al cluster", danger: true },
//
// - `cmd`: the program, then any subcommand words. The program is matched
//   without its folder or extension, ignoring case (`C:\Git\bin\git.exe` is
//   `git`); every word may list spellings with "|": "rm|del|Remove-Item".
//   An array of patterns matches any of them. Options before a subcommand
//   (`git -C dir push`) are skipped — see GLOBAL_OPTIONS.
// - `values`: the options that take a value, so the value is not mistaken for
//   an argument (`-m` in `git commit -m "fix" file.ts`).
// - `when(a)`: an extra condition on the arguments (optional).
// - `say`: a template, or a function of the arguments (`a`) and the context
//   (`c`) returning the line — or null for "not mine, try the next rule", or ""
//   for "known, nothing worth saying" (`echo`: its `> file` still shows). A
//   function may also return `{ text, danger, branch }`; `branch` is for a
//   command that checks out another branch (see `switchTo`).
//   Template placeholders each insert one quoted value:
//     {1} {2} …   the arguments after `cmd`; {last} the last one
//     {all}       all of them: "a", "b" y "c"
//     {-m} {--output} …  an option's value (list it in `values` too)
//     {branch}    the git branch the command runs on — "la rama actual" at
//                 first, its name once the app has asked git (see branchDirs)
//   and an optional filter: {1:base} the last path component, {1:host} a URL's
//   host, {-m:msg} the first line of a commit message, {1:repo} a repository's
//   name from its URL. A placeholder with nothing to fill it means the rule
//   does not apply. In a function, `q(x)` quotes a value and `list(xs)` joins
//   several; `base`, `host` and `messageTitle` are the filters.
// - `danger`: true, or a test of the arguments, for what is destructive or
//   hard to undo. The card shows those parts in red, with a ⚠ at the start of
//   the line.
//
// Options: `-x` keeps its case, longer ones (`--force`, PowerShell's
// `-Recurse`) do not, PowerShell's abbreviations (`-Rec`) count, and short
// clusters (`-rf`) are looked into — see parseArgs. `/s`-style switches are
// read as options only for Windows programs (`del`, `robocopy`…): elsewhere a
// word starting with `/` is a path.
//
// Only what is on the command line is used: nothing here reads files or runs
// anything. The one exception is the branch, which the island asks the app for
// separately (Bridge.gitBranch) and hands back through `branches`.

// ── Results ──────────────────────────────────────────────────────────────────

export interface Part {
  text: string;
  /** Destructive or hard to undo. */
  danger: boolean;
}

export interface Explanation {
  parts: Part[];
  /** Any part dangerous. */
  danger: boolean;
  /**
   * Folders whose current git branch would complete a part (`Commit en la rama
   * actual` → `Commit en "dev"`): "" is the session's own folder, anything else
   * a `cd` target relative to it (or absolute). Turn them into real folders
   * with resolveFolder() and pass the answers back as `branches`.
   */
  branchDirs: string[];
}

/** Branches the caller has found, keyed by the folder exactly as in `branchDirs`. */
export type Branches = ReadonlyMap<string, string>;

/** The explanation as one line of text, parts joined by " → ". */
export const explanationText = (e: Explanation): string => e.parts.map((p) => p.text).join(" → ");

// ── Cutting a command line into simple commands ──────────────────────────────

/** One simple command of a command line. */
export interface Simple {
  /** Its words, quotes removed; redirections are not among them. */
  words: string[];
  /** Files its output is written to (`> f`, `>> f`, `2> f`). */
  writes: { file: string; append: boolean }[];
  /** What joins it to the command before: "&&", "||", ";", "|", "&", "\n", or "" for the first. */
  joinedBy: string;
}

/** After a backslash outside quotes, these characters are taken literally; any other keeps the backslash (a Windows path). */
const ESCAPABLE = new Set([" ", "\t", "'", '"', "\\", ";", "&", "|", "(", ")", "<", ">", "$", "`", "#", "*", "?"]);

/** A word being read that is already a Windows path (`C:…`, or with a backslash): its next backslash is a separator, not an escape (`C:\temp\*.*`). */
const windowsPath = (word: string | null) => word !== null && (/^[A-Za-z]:/.test(word) || word.includes("\\"));

const WORD_END = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "<", ">", "(", ")"]);

interface Heredoc {
  tag: string;
  /** `<<-`: leading tabs are stripped from its lines. */
  tabs: boolean;
}

/** Reads a double-quoted string starting after its opening quote. Returns its text and the index after the closing quote. */
function readDouble(src: string, i: number): [string, number] {
  let text = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return [text, i + 1];
    if (c === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
      if (src[i + 1] !== "\n") text += src[i + 1];
      i += 2;
      continue;
    }
    // PowerShell's escaped quote.
    if (c === "`" && src[i + 1] === '"') {
      text += '"';
      i += 2;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = skipSubstitution(src, i + 2);
      text += src.slice(i, end);
      i = end;
      continue;
    }
    text += c;
    i++;
  }
  return [text, i];
}

/** Reads a heredoc's tag (`EOF`, `'EOF'`, `"EOF"`) at `i`. Returns it and the index after it. */
function readTag(src: string, i: number): [string, number] {
  while (src[i] === " " || src[i] === "\t") i++;
  let tag = "";
  while (i < src.length && !WORD_END.has(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      const stop = end < 0 ? src.length : end;
      tag += src.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === "\\") {
      tag += src[i + 1] ?? "";
      i += 2;
    } else {
      tag += c;
      i++;
    }
  }
  return [tag, i];
}

/** Skips the bodies of the heredocs opened on the line that just ended; `i` is the start of the next line. */
function skipHeredocs(src: string, i: number, docs: Heredoc[]): number {
  for (const doc of docs) {
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      let line = src.slice(i, end).replace(/\r$/, "");
      if (doc.tabs) line = line.replace(/^\t+/, "");
      i = end + 1;
      // Lenient on surrounding blanks: this only has to find where the text ends.
      if (line.trim() === doc.tag) break;
    }
  }
  return Math.min(i, src.length);
}

/** Skips a `$( … )` starting after its `$(`. Returns the index after its `)`. */
function skipSubstitution(src: string, i: number): number {
  let depth = 1;
  const docs: Heredoc[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      i = readDouble(src, i + 1)[1];
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      i += 2;
      const tabs = src[i] === "-";
      if (tabs) i++;
      const [tag, end] = readTag(src, i);
      if (tag) docs.push({ tag, tabs });
      i = end;
    } else if (c === "\n") {
      i = docs.length ? skipHeredocs(src, i + 1, docs.splice(0)) : i + 1;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return i;
}

/**
 * Cuts a command line into simple commands. Understands enough of bash,
 * PowerShell and cmd to never cut inside quotes, `$( … )` or a heredoc, and to
 * tell redirections from arguments. Not a shell: nothing is expanded.
 */
export function splitCommand(src: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [];
  let writes: Simple["writes"] = [];
  let word: string | null = null;
  let joinedBy = "";
  /** A redirection waiting for its target: "write", "append", or "skip" (input, fd copies). */
  let redirect: "write" | "append" | "skip" | null = null;
  let docs: Heredoc[] = [];

  const add = (text: string) => {
    word = (word ?? "") + text;
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect) {
      if (redirect !== "skip") writes.push({ file: word, append: redirect === "append" });
      redirect = null;
    } else {
      words.push(word);
    }
    word = null;
  };
  const endCommand = (sep: string) => {
    endWord();
    redirect = null;
    // Nothing before it (a leading `&`, PowerShell's call operator, or `(`):
    // there is no command to end, and the separator before still stands.
    if (words.length === 0 && writes.length === 0) return;
    out.push({ words, writes, joinedBy });
    words = [];
    writes = [];
    joinedBy = sep;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\n") {
      endWord();
      i = docs.length ? skipHeredocs(src, i + 1, docs) : i + 1;
      docs = [];
      endCommand("\n");
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "\\") {
      if (next === "\n") {
        i += 2; // line continuation
      } else if (next !== undefined && ESCAPABLE.has(next) && !windowsPath(word)) {
        add(next);
        i += 2;
      } else {
        add(c);
        i++;
      }
    } else if (c === "`" && (next === "\n" || (next === "\r" && src[i + 2] === "\n"))) {
      i += next === "\n" ? 2 : 3; // PowerShell's line continuation
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      add(src.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '"') {
      const [text, end] = readDouble(src, i + 1);
      add(text);
      i = end;
    } else if (c === "$" && next === "(") {
      const end = skipSubstitution(src, i + 2);
      add(src.slice(i, end));
      i = end;
    } else if (c === "&" && next === "&") {
      endCommand("&&");
      i += 2;
    } else if (c === "|" && next === "|") {
      endCommand("||");
      i += 2;
    } else if (c === "|") {
      endCommand("|");
      i += next === "&" ? 2 : 1;
    } else if (c === ";") {
      endCommand(";");
      i += next === ";" ? 2 : 1;
    } else if (c === "&" && next === ">") {
      endWord();
      const append = src[i + 2] === ">";
      redirect = append ? "append" : "write";
      i += append ? 3 : 2;
    } else if (c === ">" || c === "<") {
      // A word of digits right before is the descriptor (`2>`), not an argument.
      if (word !== null && /^\d+$/.test(word)) word = null;
      else endWord();
      if (c === "<" && next === "<" && src[i + 2] === "<") {
        redirect = "skip"; // here-string
        i += 3;
      } else if (c === "<" && next === "<") {
        i += 2;
        const tabs = src[i] === "-";
        if (tabs) i++;
        const [tag, end] = readTag(src, i);
        if (tag) docs.push({ tag, tabs });
        i = end;
      } else if (c === "<") {
        redirect = "skip";
        i += next === "&" ? 2 : 1;
      } else if (next === "&") {
        redirect = "skip"; // `>&2`: into another descriptor, not a file
        i += 2;
      } else {
        const append = next === ">";
        redirect = append ? "append" : "write";
        i += append || next === "|" ? 2 : 1;
      }
    } else if (c === "&") {
      endCommand("&");
      i++;
    } else if (c === "(" || c === ")") {
      // A subshell's parentheses: the commands inside count like the others.
      endCommand(";");
      i++;
    } else {
      add(c);
      i++;
    }
  }
  endCommand("");
  return out;
}

// ── Arguments ────────────────────────────────────────────────────────────────

/** A simple command's arguments, after the words its rule matched. */
export interface Args {
  /** Every word after the matched ones, as written. */
  words: string[];
  /** The arguments that are neither options nor option values. */
  positional: string[];
  /** Any of these options present. `-r` also finds `-rf`; `-recurse` also finds PowerShell's `-Rec`. */
  has(...names: string[]): boolean;
  /** The value of the first of these options present. */
  opt(...names: string[]): string | undefined;
}

/**
 * Whether option `written` is option `name`. Short options keep their case
 * (`-d` is not `-D`, `-O` is not `-o`); longer ones ignore it, as PowerShell
 * does (`-Recurse`, `-recurse`).
 */
function sameOption(written: string, name: string): boolean {
  if (written === name) return true;
  return written.length > 2 && name.length > 2 && written.toLowerCase() === name.toLowerCase();
}

/**
 * Windows programs take `/s`-style switches; anywhere else a word starting
 * with `/` is a path (`rm -rf /tmp`). `rmdir` and `cd` exist on both sides,
 * so only their few one-letter switches count there.
 */
const SLASH_SWITCH_PROGRAMS = new Set([
  "del", "erase", "rd", "dir", "copy", "xcopy", "robocopy", "move", "ren", "rename", "findstr", "taskkill",
  "attrib", "icacls", "where", "start", "timeout", "shutdown", "cmd",
]);

function slashSwitch(prog: string): RegExp | null {
  if (SLASH_SWITCH_PROGRAMS.has(prog)) return /^\/[A-Za-z?]+(?::\S*)?$/;
  if (prog === "rmdir" || prog === "cd" || prog === "chdir") return /^\/[sqdSQD]$/;
  return null;
}

interface Opt {
  key: string;
  value: string | null;
  /** A run of short options written as one word: `-rf`, `-xzf`, `-qO-`. */
  cluster: boolean;
}

/**
 * Reads the words after a command: options (with the values of those listed in
 * `values`), and positional arguments. `--` ends the options. Single-dash words
 * of up to four letters are clusters of short options (`-rf`, `-am msg`,
 * `-qO-`); longer ones are one option, PowerShell style (`-Recurse`,
 * `-Path:x`). `/x` switches only for the programs `slash` says take them.
 */
export function parseArgs(words: string[], values: readonly string[] = [], slash: RegExp | null = null): Args {
  const takesValue = (w: string) => values.some((v) => sameOption(w, v));
  const opts: Opt[] = [];
  const positional: string[] = [];
  let rest = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isSwitch = !!slash && slash.test(w);
    if (rest || w === "-" || !(isOption(w) || isSwitch)) {
      positional.push(w);
      continue;
    }
    if (w === "--") {
      rest = true;
      continue;
    }
    if (isSwitch) {
      const colon = w.indexOf(":");
      if (colon > 0) opts.push({ key: w.slice(0, colon), value: w.slice(colon + 1), cluster: false });
      else if (takesValue(w)) opts.push({ key: w, value: words[++i] ?? null, cluster: false });
      else opts.push({ key: w, value: null, cluster: false });
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      if (eq > 0) opts.push({ key: w.slice(0, eq), value: w.slice(eq + 1), cluster: false });
      else if (takesValue(w)) opts.push({ key: w, value: words[++i] ?? null, cluster: false });
      else opts.push({ key: w, value: null, cluster: false });
      continue;
    }
    if (takesValue(w)) {
      opts.push({ key: w, value: words[++i] ?? null, cluster: false });
      continue;
    }
    // PowerShell's `-Name:value`.
    const colon = w.indexOf(":");
    if (colon > 1 && takesValue(w.slice(0, colon))) {
      opts.push({ key: w.slice(0, colon), value: w.slice(colon + 1), cluster: false });
      continue;
    }
    const run = w.match(/^-([A-Za-z]+)(.*)$/);
    if (run && run[1].length <= 4) {
      // A cluster: letters up to the first that takes a value; that one gets
      // the rest of the word (`-mfix`, `-qO-`) or else the next word (`-am msg`).
      const letters = run[1] + run[2];
      let k = 0;
      while (k < letters.length && /[A-Za-z]/.test(letters[k]) && !takesValue(`-${letters[k]}`)) k++;
      if (k > 0) opts.push({ key: `-${letters.slice(0, k)}`, value: null, cluster: true });
      if (k < letters.length && takesValue(`-${letters[k]}`)) {
        const attached = letters.slice(k + 1);
        opts.push({ key: `-${letters[k]}`, value: attached || (words[++i] ?? null), cluster: false });
      }
      continue;
    }
    opts.push({ key: w, value: null, cluster: false });
  }

  const found = (name: string) =>
    opts.find((o) => {
      if (sameOption(o.key, name)) return true;
      // Inside a cluster: `-rf` has `-r` and `-f`.
      if (o.cluster && /^-[A-Za-z]$/.test(name) && o.key.includes(name[1])) return true;
      // PowerShell takes any unambiguous prefix: `-Rec`, `-Recu`… for `-Recurse`.
      return (
        name.length > 4 && !name.startsWith("--") && o.key.length >= 4 && !o.key.startsWith("--") &&
        !o.key.startsWith("/") && name.toLowerCase().startsWith(o.key.toLowerCase())
      );
    });
  return {
    words,
    positional,
    has: (...names) => names.some((n) => found(n) !== undefined),
    opt: (...names) => {
      for (const n of names) {
        const o = opts.find((x) => sameOption(x.key, n));
        if (o?.value != null && o.value !== "") return o.value;
      }
      return undefined;
    },
  };
}

// ── Showing values ───────────────────────────────────────────────────────────

/** Wraps a value in quotes for the line. */
export const q = (value: string) => `"${value}"`;

/** A path as written, minus a leading `./` and trailing separators. */
function tidy(path: string): string {
  let p = path.trim().replace(/^\.[\\/](?=.)/, "");
  if (p.length > 1) p = p.replace(/[\\/]+$/, "");
  return p || path;
}

/** The last component of a path: `C:\repo\src\x.ts` → `x.ts`; `/` stays `/`. */
export function base(path: string): string {
  const p = tidy(path);
  if (/^[A-Za-z]:[\\/]?$/.test(p) || p === "/" || p === "\\") return p;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? p;
}

/** A URL's host (`https://api.github.com/x` → `api.github.com`), or the text up to its first `/`. */
export function host(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return u.host || url;
  } catch {
    return url.split("/")[0] || url;
  }
}

/** The first line of a commit message — also out of the `"$(cat <<'EOF' … EOF)"` Claude Code writes. */
export function messageTitle(value: string): string {
  const here = value.match(/^\$\(\s*cat\s*<<-?\s*(['"]?)([^\s'"]+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\r?(?:\n[\s\S]*)?\)\s*$/);
  const text = here ? here[3] : value;
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/** A repository's name from its URL or path: `https://github.com/a/b.git` → `b`. */
function repoName(url: string): string {
  return base(url.replace(/[?#].*$/, "")).replace(/\.git$/i, "").split(":").at(-1) || url;
}

const FILTERS: Record<string, (v: string) => string> = {
  base,
  host,
  msg: messageTitle,
  repo: repoName,
};

/** `"a"`, `"a" y "b"`, `"a", "b" y "c"`; past four, `"a", "b", "c" y 2 más`. */
export function list(values: string[], show: (v: string) => string = tidy): string {
  const shown = values.map((v) => q(show(v)));
  if (shown.length <= 1) return shown.join("");
  if (shown.length > 4) return `${shown.slice(0, 3).join(", ")} y ${shown.length - 3} más`;
  return `${shown.slice(0, -1).join(", ")} y ${shown.at(-1)}`;
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** What a rule's `say` can use beyond the arguments. */
export interface Ctx {
  /** The program as written, without folder or extension: "git", "remove-item". */
  prog: string;
  /** `"dev"` once the branch is known, `la rama actual` until then. */
  branch(): string;
  /** This command reads the output of the one before (`a | b`). */
  piped: boolean;
}

/**
 * What a rule's `say` returns: the line, or the line with flags — `danger`, and
 * `branch` for a command that changes the branch checked out (`git checkout
 * x`): later parts of the same line then name that branch instead of asking
 * git for one that will no longer be current (null: no longer known).
 */
type Said = string | { text: string; danger?: boolean; branch?: string | null } | null;

export interface Rule {
  cmd: string | string[];
  values?: readonly string[];
  when?: (a: Args) => boolean;
  say: string | ((a: Args, c: Ctx) => Said);
  danger?: boolean | ((a: Args) => boolean);
}

/**
 * Options a program takes before its subcommand that take a value, keyed by
 * the program and the subcommands matched so far. Any other option there is
 * skipped on its own.
 */
const GLOBAL_OPTIONS: Record<string, readonly string[]> = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"],
  npm: ["--prefix", "-w", "--workspace", "--userconfig", "--registry"],
  pnpm: ["-C", "--dir", "--filter", "-F", "-w", "--workspace"],
  yarn: ["--cwd"],
  bun: ["--cwd"],
  cargo: ["--manifest-path", "--config", "-Z", "-C"],
  docker: ["--context", "-c", "-H", "--host", "--config", "-l", "--log-level"],
  "docker compose": ["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"],
  "docker-compose": ["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"],
  gh: ["-R", "--repo"],
  uv: ["--directory", "--project"],
};

const SHELLS = "sh|bash|zsh|dash|ksh";
const POWERSHELL = "powershell|pwsh";

/** True when `path` names "everything": a drive, the root, home, the current folder, or a bare wildcard. */
const WIDE = /^(?:\/|\\|[A-Za-z]:[\\/]?|~[\\/]?|\$HOME[\\/]?|\$env:USERPROFILE[\\/]?|%USERPROFILE%[\\/]?|\.[\\/]?|\*|\.[\\/]\*|\*\.\*)$/i;

const hasGlob = (v: string) => /[*?]/.test(v);

/** How a delete names what it deletes: words for the targets that mean "everything", quoted names for the rest. */
function deletion(targets: string[], recursive: boolean): string {
  const wide = targets.find((t) => WIDE.test(t.trim()));
  if (wide) {
    const t = wide.trim();
    if (/^~|HOME|USERPROFILE/i.test(t)) return recursive ? "Eliminar tu carpeta personal y todo su contenido" : "Eliminar tu carpeta personal";
    if (/^\.[\\/]?$/.test(t)) return recursive ? "Eliminar la carpeta actual y todo su contenido" : "Eliminar la carpeta actual";
    if (/\*/.test(t)) return recursive ? "Eliminar todo lo de la carpeta actual, subcarpetas incluidas" : "Eliminar todo lo de la carpeta actual";
    return "Eliminar todo el disco";
  }
  if (targets.length === 0) return recursive ? "Eliminar archivos y carpetas con todo su contenido" : "Eliminar archivos";
  const names = list(targets, base);
  if (!recursive) return `Eliminar ${names}`;
  // `del /s *.tmp`: matching files down the tree, not a folder and its contents.
  return targets.every(hasGlob) ? `Eliminar ${names} de esta carpeta y sus subcarpetas` : `Eliminar ${names} y todo su contenido`;
}

/** Same folder in both paths (or neither names one): a rename, not a move. */
function sameFolder(a: string, b: string): boolean {
  const dir = (p: string) => tidy(p).replace(/[^\\/]*$/, "").replace(/[\\/]+$/, "");
  return !/[\\/]$/.test(b) && b !== "." && b !== ".." && dir(a) === dir(b);
}

/** Where a move or copy goes, in words. */
function destination(path: string): string {
  const p = tidy(path);
  if (p === ".") return "la carpeta actual";
  if (p === "..") return "la carpeta de arriba";
  return q(base(p));
}

/** A ref that looks like a commit rather than a file: HEAD~2, a SHA, origin/main. */
const REF = /^(?:HEAD|@|ORIG_HEAD|FETCH_HEAD)(?:[~^]\d*)*$|^[0-9a-f]{7,40}$|^(?:origin|upstream)\//;

/** A word that looks like a file rather than a branch: an extension that is not a version number. */
const looksLikeFile = (v: string) => /\.[A-Za-z][A-Za-z0-9]{0,6}$/.test(v) && !v.includes("..");

/** `git checkout x` / `git switch x`: to a branch, back to the previous one, or onto a commit (no branch). */
function switchTo(target: string): Said {
  if (target === "-") return { text: "Volver a la rama anterior", branch: null };
  if (REF.test(target)) return { text: `Pasarse a ${q(target)} (sin rama)`, branch: null };
  return { text: `Pasarse a la rama ${q(target)}`, branch: target };
}

/** `(remoto "upstream")` when a push or pull goes somewhere other than origin. */
function remoteNote(remote: string | undefined): string {
  if (!remote || remote === "origin") return "";
  return ` (remoto ${q(/:\/\/|@/.test(remote) ? host(remote.replace(/^[^@]*@/, "")) : remote)})`;
}

/** A URL among the arguments: the first that looks like one, else the first argument. */
function urlOf(a: Args, ...named: string[]): string | undefined {
  const fromOpt = a.opt(...named);
  if (fromOpt) return fromOpt;
  return a.positional.find((p) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(p) || /^localhost(?::\d+)?/.test(p))
    ?? a.positional[0];
}

/** The file a URL would be saved as (`-O`, `wget`): its last path component. */
function urlFile(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return base(u.pathname) || u.host;
  } catch {
    return base(url);
  }
}

const WGET_VALUES = [
  "-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix",
  "-U", "--user-agent", "--header", "-e", "--execute", "-t", "--tries", "-T", "--timeout", "-w", "--wait",
  "--post-data", "--post-file", "--method", "--body-data", "-i", "--input-file", "--user", "--password",
];

const CURL_VALUES = [
  "-o", "--output", "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-H", "--header", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-F", "--form", "-T",
  "--upload-file", "-b", "--cookie", "-c", "--cookie-jar", "-m", "--max-time", "--connect-timeout", "-w",
  "--write-out", "-x", "--proxy", "--retry", "-r", "--range", "--cacert", "--cert", "--key", "-K", "--config",
  "--json", "--url",
  // PowerShell's Invoke-WebRequest / Invoke-RestMethod (and `curl`, its alias in Windows PowerShell).
  "-Uri", "-OutFile", "-Method", "-Body", "-Headers", "-ContentType", "-InFile", "-UserAgent", "-TimeoutSec",
];

/** curl, wget and PowerShell's web cmdlets: download, send, or just look. */
function web(a: Args, c: Ctx): Said {
  const url = urlOf(a, "--url", "-Uri");
  if (!url) return null;
  const where = q(host(url));
  const wget = c.prog === "wget";
  // curl -o, wget -O, Invoke-WebRequest -OutFile. "-" is standard output: read, not saved.
  const out = wget ? a.opt("-O", "--output-document") : a.opt("-o", "--output", "-OutFile");
  const method = (a.opt("-X", "--request", "-Method", "--method") ?? "").toUpperCase();
  const sends = (wget
    ? a.has("--post-data", "--post-file", "--body-data")
    : a.has("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--json", "-T", "--upload-file", "-Body", "-InFile"))
    || ["POST", "PUT", "PATCH"].includes(method);
  if (method === "DELETE") return { text: `Borrar algo en ${where}`, danger: true };
  if (sends) return `Enviar datos a ${where}`;
  if (out && out !== "-") return `Descargar ${q(base(out))} de ${where}`;
  if (c.prog === "curl" && a.has("-O", "--remote-name")) return `Descargar ${q(urlFile(url))} de ${where}`;
  // wget saves unless told to write to standard output (`-O -`, `-qO-`).
  if (wget && out !== "-") return `Descargar ${q(urlFile(url))} de ${where}`;
  return `Consultar ${where}`;
}

/** pnpm / yarn / bun subcommands that are not a package.json script. */
const NOT_SCRIPTS = new Set([
  "workspaces", "dlx", "exec", "why", "info", "view", "config", "cache", "global", "link", "unlink", "pack",
  "plugin", "set", "store", "env", "import", "patch", "patch-commit", "prune", "rebuild", "fetch", "recursive",
  "self-update", "setup", "approve-builds", "node", "constraints", "npm", "upgrade-interactive", "dedupe",
  "licenses", "login", "logout", "whoami", "search", "server", "server-start",
]);

const NPM_INSTALL_VALUES = ["--registry", "--tag", "-w", "--workspace", "--prefix", "--filter", "-F"];

/** npm / pnpm / yarn / bun install: dependencies, or named packages. */
function install(a: Args): Said {
  const pkgs = a.positional;
  if (pkgs.length === 0) return "Instalar las dependencias";
  let text = `Instalar ${list(pkgs)}`;
  if (a.has("-g", "--global")) text += " globalmente";
  else if (a.has("-D", "--save-dev", "--dev", "-d")) text += " como dependencia de desarrollo";
  return text;
}

/** `npm run x`, `yarn x`…: a package.json script, with the usual ones in words. */
function script(name: string | undefined): Said {
  if (!name) return null;
  if (name === "test" || name === "t") return "Correr los tests";
  return `Correr el script ${q(name)}`;
}

/**
 * The rules. Order matters: the first that says something wins, so specific
 * rules sit above general ones for the same program.
 */
export const RULES: Rule[] = [
  // ── git ────────────────────────────────────────────────────────────────────
  {
    cmd: "git push",
    values: ["-o", "--push-option", "--repo", "--receive-pack", "--exec"],
    say: (a, c) => {
      const [remote, ...refs] = a.positional;
      const note = remoteNote(remote);
      const forced = a.has("-f", "--force", "--force-with-lease", "--force-if-includes") || refs.some((r) => r.startsWith("+"));
      const tail = forced ? " (forzado)" : "";
      if (a.has("-d", "--delete") || (refs.length === 1 && refs[0].startsWith(":"))) {
        const gone = refs.map((r) => r.replace(/^:/, ""));
        if (gone.length === 0) return null;
        return { text: `Borrar ${gone.length > 1 ? "las ramas remotas" : "la rama remota"} ${list(gone)}${note}`, danger: true };
      }
      if (refs.length === 0) {
        if (a.has("--tags")) return { text: `Push de los tags${note}${tail}`, danger: forced };
        return { text: `Push de ${c.branch()}${note}${tail}`, danger: forced };
      }
      if (refs.length === 1) {
        const ref = refs[0].replace(/^\+/, "");
        const [src, dst] = ref.includes(":") ? ref.split(":", 2) : [ref, ""];
        const from = src === "HEAD" || src === "@" ? c.branch() : q(src);
        const to = dst && dst !== src ? ` a ${q(dst.replace(/^refs\/heads\//, ""))}` : "";
        return { text: `Push de ${from}${to}${note}${tail}`, danger: forced };
      }
      return { text: `Push de ${list(refs.map((r) => r.replace(/^\+/, "")))}${note}${tail}`, danger: forced };
    },
  },
  {
    cmd: "git commit",
    values: [
      "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date",
      "--fixup", "--squash", "-t", "--template", "--cleanup", "--trailer", "--pathspec-from-file",
    ],
    say: (a, c) => {
      const msg = a.opt("-m", "--message");
      const title = msg ? messageTitle(msg) : "";
      const what = a.has("--amend") ? `Reescribir el último commit en ${c.branch()}` : `Commit en ${c.branch()}`;
      return title ? `${what}: ${q(title)}` : what;
    },
  },
  {
    cmd: "git pull",
    values: ["-s", "--strategy", "-X", "--strategy-option", "--depth"],
    say: (a, c) => {
      const [remote, ...refs] = a.positional;
      const how = a.has("-r", "--rebase") ? " (con rebase)" : "";
      const from = refs.length ? `de ${list(refs)} ` : "";
      return `Pull ${from}en ${c.branch()}${remoteNote(remote)}${how}`;
    },
  },
  { cmd: "git fetch", say: (a) => `Traer las novedades del remoto${remoteNote(a.positional[0])}` },
  {
    cmd: "git checkout",
    values: ["-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"],
    say: (a) => {
      const created = a.opt("-b", "-B", "--orphan");
      if (created) {
        const from = a.positional[0];
        return { text: `Crear la rama ${q(created)}${from ? ` desde ${q(from)}` : ""} y pasarse a ella`, branch: created };
      }
      const dashdash = a.words.indexOf("--");
      if (dashdash >= 0) {
        const files = a.words.slice(dashdash + 1);
        const source = a.positional.find((p) => !files.includes(p));
        if (files.length === 0) return null;
        if (source) return { text: `Reemplazar ${list(files, base)} por la versión de ${q(source)}`, danger: true };
        return { text: files.includes(".") ? "Descartar todos los cambios sin commit" : `Descartar los cambios de ${list(files, base)}`, danger: true };
      }
      const [target] = a.positional;
      if (!target) return null;
      if (target === ".") return { text: "Descartar todos los cambios sin commit", danger: true };
      if (looksLikeFile(target)) return { text: `Descartar los cambios de ${list(a.positional, base)}`, danger: true };
      return switchTo(target);
    },
  },
  {
    cmd: "git switch",
    values: ["-c", "-C", "--create", "--force-create", "--orphan", "--conflict"],
    say: (a) => {
      const created = a.opt("-c", "-C", "--create", "--force-create", "--orphan");
      if (created) {
        const from = a.positional[0];
        return { text: `Crear la rama ${q(created)}${from ? ` desde ${q(from)}` : ""} y pasarse a ella`, branch: created };
      }
      const [target] = a.positional;
      return target ? switchTo(target) : null;
    },
  },
  {
    cmd: "git restore",
    values: ["-s", "--source", "--pathspec-from-file"],
    say: (a) => {
      const files = a.positional;
      if (files.length === 0) return null;
      if (a.has("-S", "--staged") && !a.has("-W", "--worktree")) {
        return files.includes(".") ? "Sacar todo del staging" : `Sacar ${list(files, base)} del staging`;
      }
      return { text: files.includes(".") ? "Descartar todos los cambios sin commit" : `Descartar los cambios de ${list(files, base)}`, danger: true };
    },
  },
  {
    cmd: "git merge",
    values: ["-m", "-s", "--strategy", "-X", "--strategy-option", "-F", "--file"],
    say: (a, c) => {
      if (a.has("--abort")) return "Cancelar el merge en curso";
      if (a.has("--continue")) return "Continuar el merge";
      if (a.positional.length === 0) return null;
      const squash = a.has("--squash") ? " (squash)" : "";
      return `Merge de ${list(a.positional)} en ${c.branch()}${squash}`;
    },
  },
  {
    cmd: "git rebase",
    values: ["--onto", "-s", "--strategy", "-X", "--strategy-option", "-x", "--exec"],
    say: (a, c) => {
      if (a.has("--abort")) return "Cancelar el rebase en curso";
      if (a.has("--continue")) return "Continuar el rebase";
      if (a.has("--skip")) return "Saltear este commit del rebase";
      const onto = a.opt("--onto") ?? a.positional[0];
      const how = a.has("-i", "--interactive") ? "Rebase interactivo" : "Rebase";
      return onto ? `${how} de ${c.branch()} sobre ${q(onto)}` : `${how} de ${c.branch()}`;
    },
  },
  {
    cmd: "git reset",
    values: ["--pathspec-from-file"],
    say: (a) => {
      const dashdash = a.words.indexOf("--");
      const files = dashdash >= 0 ? a.words.slice(dashdash + 1) : a.positional.filter((p) => !REF.test(p));
      const ref = a.positional.find((p) => REF.test(p) || (dashdash >= 0 && !files.includes(p)));
      if (a.has("--hard")) {
        return { text: ref ? `Volver a ${q(ref)} y descartar todos los cambios sin commit` : "Descartar todos los cambios sin commit", danger: true };
      }
      if (a.has("--soft")) return `Deshacer los commits hasta ${q(ref ?? "HEAD")} (los cambios quedan en staging)`;
      if (files.length) return files.includes(".") ? "Sacar todo del staging" : `Sacar ${list(files, base)} del staging`;
      if (ref && ref !== "HEAD") return `Deshacer los commits hasta ${q(ref)} (los cambios quedan)`;
      return "Sacar todo del staging";
    },
  },
  {
    cmd: "git clone",
    values: ["-b", "--branch", "--depth", "-o", "--origin", "--reference", "-c", "--config", "--filter", "-j", "--jobs", "--separate-git-dir", "-u", "--upload-pack", "--template", "--shallow-since", "--shallow-exclude"],
    say: (a) => {
      const [url, dir] = a.positional;
      if (!url) return null;
      return `Clonar ${q(repoName(url))}${dir ? ` en ${q(base(dir))}` : ""}`;
    },
  },
  {
    cmd: "git add",
    values: ["--chmod", "--pathspec-from-file"],
    say: (a) => {
      if (a.has("-p", "--patch", "-i", "--interactive")) return "Elegir qué cambios agregar al staging";
      if (a.has("-A", "--all") || a.positional.includes(".") || a.positional.includes("-A")) return "Agregar todos los cambios al staging";
      if (a.has("-u", "--update")) return "Agregar los cambios de los archivos ya seguidos al staging";
      if (a.positional.length === 0) return null;
      return `Agregar ${list(a.positional, base)} al staging`;
    },
  },
  { cmd: "git status", say: "Ver el estado del repo" },
  {
    cmd: "git diff",
    say: (a) => {
      const staged = a.has("--staged", "--cached");
      const files = a.positional.filter((p) => !REF.test(p) && !p.includes(".."));
      if (staged) return "Ver los cambios en staging";
      return files.length && files.every(looksLikeFile) ? `Ver los cambios de ${list(files, base)}` : "Ver los cambios";
    },
  },
  { cmd: "git log", values: ["-n", "--max-count", "--since", "--until", "--author", "--grep", "--format", "--pretty"], say: "Ver el historial de commits" },
  { cmd: "git show", say: (a) => (a.positional[0] && !looksLikeFile(a.positional[0]) ? `Ver el commit ${q(a.positional[0])}` : "Ver el último commit") },
  { cmd: "git blame", values: ["-L"], say: "Ver quién cambió cada línea de {last:base}" },
  {
    cmd: "git branch",
    values: ["-m", "-M", "--set-upstream-to", "-u", "--contains", "--merged", "--no-merged", "--sort", "--format"],
    say: (a) => {
      if (a.has("-D") || (a.has("-d", "--delete") && a.has("-f", "--force"))) return { text: `Borrar la rama ${list(a.positional)} (aunque no esté mergeada)`, danger: true };
      if (a.has("-d", "--delete")) return a.positional.length ? `Borrar la rama ${list(a.positional)}` : null;
      const renamed = a.opt("-m", "-M");
      if (renamed) return a.positional.length ? `Renombrar la rama ${q(renamed)} a ${q(a.positional[0])}` : `Renombrar la rama actual a ${q(renamed)}`;
      if (a.has("--show-current")) return "Ver la rama actual";
      if (a.positional.length && !a.has("-a", "-r", "--all", "--list", "-l", "-v", "-vv")) return `Crear la rama ${q(a.positional[0])}`;
      return "Ver las ramas";
    },
  },
  {
    cmd: "git stash",
    values: ["-m", "--message"],
    say: (a) => {
      const [sub] = a.positional;
      switch (sub) {
        case undefined:
        case "push":
        case "save":
          return "Guardar los cambios en el stash";
        case "pop":
          return "Recuperar los cambios del stash";
        case "apply":
          return "Aplicar los cambios del stash";
        case "list":
          return "Ver el stash";
        case "show":
          return "Ver lo guardado en el stash";
        case "drop":
          return { text: "Borrar una entrada del stash", danger: true };
        case "clear":
          return { text: "Borrar todo el stash", danger: true };
        default:
          return null;
      }
    },
  },
  {
    cmd: "git tag",
    values: ["-m", "--message", "-F", "--file", "-u", "--local-user", "--sort", "--format", "--contains"],
    say: (a) => {
      if (a.has("-d", "--delete")) return a.positional.length ? { text: `Borrar el tag ${list(a.positional)}`, danger: true } : null;
      if (a.positional.length && !a.has("-l", "--list")) return `Crear el tag ${q(a.positional[0])}`;
      return "Ver los tags";
    },
  },
  {
    cmd: "git clean",
    values: ["-e", "--exclude"],
    say: (a) => {
      if (a.has("-n", "--dry-run")) return "Ver qué archivos sin seguimiento se borrarían";
      return { text: a.has("-d") ? "Borrar los archivos y carpetas sin seguimiento" : "Borrar los archivos sin seguimiento", danger: true };
    },
  },
  { cmd: "git cherry-pick", say: (a, c) => (a.has("--abort") ? "Cancelar el cherry-pick" : a.has("--continue") ? "Continuar el cherry-pick" : a.positional.length ? `Aplicar ${list(a.positional)} en ${c.branch()}` : null) },
  { cmd: "git revert", values: ["-m", "--mainline"], say: (a) => (a.has("--abort") ? "Cancelar el revert" : a.positional.length ? `Revertir el commit ${list(a.positional)}` : null) },
  {
    cmd: "git rm",
    say: (a) => {
      if (a.positional.length === 0) return null;
      if (a.has("--cached")) return `Dejar de seguir ${list(a.positional, base)} (el archivo queda)`;
      return { text: `${deletion(a.positional, a.has("-r"))} del repo`, danger: a.has("-r") || a.positional.some(hasGlob) };
    },
  },
  { cmd: "git mv", say: (a) => (a.positional.length === 2 ? `${sameFolder(a.positional[0], a.positional[1]) ? "Renombrar" : "Mover"} ${q(base(a.positional[0]))} a ${destination(a.positional[1])}` : null) },
  { cmd: "git remote", values: ["-t", "-m"], say: (a) => (a.positional[0] === "add" && a.positional[1] ? `Agregar el remoto ${q(a.positional[1])}` : a.positional[0] === "remove" || a.positional[0] === "rm" ? `Quitar el remoto ${q(a.positional[1] ?? "")}` : "Ver los remotos") },
  {
    cmd: "git config",
    values: ["-f", "--file", "--type", "--default"],
    say: (a) => {
      const [key, value] = a.positional;
      if (a.has("--unset", "--unset-all", "--remove-section", "--rename-section", "--add", "--replace-all") || value !== undefined) {
        return key ? `Cambiar la configuración de git (${q(key)})` : "Cambiar la configuración de git";
      }
      return "Ver la configuración de git";
    },
  },
  { cmd: "git init", values: ["-b", "--initial-branch", "--template", "--separate-git-dir"], say: (a) => (a.positional[0] ? `Crear un repo git en ${q(base(a.positional[0]))}` : "Crear un repo git") },
  { cmd: "git worktree add", values: ["-b", "-B"], say: "Crear un worktree en {1:base}" },
  { cmd: "git worktree remove", say: "Eliminar el worktree {1:base}", danger: (a) => a.has("-f", "--force") },
  { cmd: "git worktree list", say: "Ver los worktrees" },

  // ── GitHub CLI ─────────────────────────────────────────────────────────────
  { cmd: "gh pr create", values: ["-t", "--title", "-b", "--body", "-B", "--base", "-H", "--head", "-F", "--body-file", "-a", "--assignee", "-l", "--label", "-r", "--reviewer", "-m", "--milestone"], say: (a) => { const t = a.opt("-t", "--title"); return t ? `Crear un pull request: ${q(t)}` : "Crear un pull request"; } },
  { cmd: "gh pr merge", say: "Mergear el pull request", danger: true },
  { cmd: "gh pr checkout|co", say: "Pasarse a la rama del pull request {1}" },
  { cmd: "gh pr view|list|status|checks|diff", say: "Ver los pull requests" },
  { cmd: "gh issue create", values: ["-t", "--title", "-b", "--body"], say: (a) => { const t = a.opt("-t", "--title"); return t ? `Crear un issue: ${q(t)}` : "Crear un issue"; } },
  { cmd: "gh issue view|list|status", say: "Ver los issues" },
  { cmd: "gh repo clone", say: "Clonar {1:repo}" },
  { cmd: "gh run view|list|watch", say: "Ver las corridas de GitHub Actions" },
  { cmd: "gh api", values: ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--jq", "-q"], say: (a) => { const m = (a.opt("-X", "--method") ?? "GET").toUpperCase(); return m === "GET" && !a.has("-f", "-F", "--field", "--raw-field") ? "Consultar la API de GitHub" : { text: `Cambiar algo por la API de GitHub (${m === "GET" ? "POST" : m})`, danger: m === "DELETE" }; } },

  // ── Folders and files ──────────────────────────────────────────────────────
  {
    cmd: "cd|chdir|set-location|sl|pushd",
    values: ["-Path", "-LiteralPath"],
    say: (a) => {
      const target = a.opt("-Path", "-LiteralPath") ?? a.positional[0];
      if (!target || target === "~" || /^(\$HOME|\$env:USERPROFILE|%USERPROFILE%)$/i.test(target)) return "Moverse a la carpeta personal";
      if (target === "-") return "Volver a la carpeta anterior";
      const ups = tidy(target).split(/[\\/]+/);
      if (ups.every((p) => p === "..")) return ups.length === 1 ? "Subir una carpeta" : `Subir ${ups.length} carpetas`;
      return `Moverse a ${q(base(target))}`;
    },
  },
  { cmd: "popd", say: "Volver a la carpeta anterior" },
  {
    cmd: "rm|del|erase|remove-item|ri|unlink|trash|rmdir|rd",
    values: ["-Path", "-LiteralPath", "-Include", "-Exclude", "-Filter"],
    say: (a, c) => {
      const named = a.opt("-Path", "-LiteralPath");
      const targets = named ? [named, ...a.positional] : a.positional;
      const folderOnly = c.prog === "rmdir" || c.prog === "rd";
      const recursive = a.has("-r", "-R", "--recursive", "-recurse", "/s", "/S");
      if (folderOnly && !recursive) return targets.length ? `Eliminar la carpeta ${list(targets, base)}` : null;
      return {
        text: deletion(targets, recursive),
        danger: recursive || targets.some((t) => hasGlob(t) || WIDE.test(t.trim())),
      };
    },
  },
  // npm's rimraf and friends: always the whole tree.
  { cmd: "rimraf|del-cli|trash-cli", say: (a) => ({ text: deletion(a.positional, true), danger: true }) },
  {
    cmd: "find",
    values: ["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-newer", "-mtime", "-size", "-exec", "-execdir", "-regex", "-user"],
    say: (a) => {
      const pattern = a.opt("-name", "-iname", "-path", "-regex");
      const where = a.positional.find((p) => !p.startsWith("-") && p !== ";" && p !== "{}" && p !== "+");
      const deletes = a.has("-delete") || /^(rm|del)$/.test(a.opt("-exec", "-execdir") ?? "");
      if (deletes) return { text: pattern ? `Eliminar los archivos ${q(pattern)} que encuentre` : "Eliminar los archivos que encuentre", danger: true };
      if (pattern) return `Buscar archivos ${q(pattern)}${where && where !== "." ? ` en ${q(base(where))}` : ""}`;
      return where && where !== "." ? `Buscar archivos en ${q(base(where))}` : "Buscar archivos";
    },
  },
  {
    cmd: "mkdir|md",
    values: ["-m", "--mode", "-Path"],
    say: (a) => {
      const dirs = [a.opt("-Path"), ...a.positional].filter((d): d is string => !!d);
      if (dirs.length === 0) return null;
      return dirs.length === 1 ? `Crear la carpeta ${q(base(dirs[0]))}` : `Crear las carpetas ${list(dirs, base)}`;
    },
  },
  {
    cmd: "new-item|ni",
    values: ["-Path", "-ItemType", "-Type", "-Name", "-Value", "-Target"],
    say: (a) => {
      const path = a.opt("-Path") ?? a.positional[0];
      const name = a.opt("-Name") ?? (path ? base(path) : undefined);
      if (!name) return null;
      const type = (a.opt("-ItemType", "-Type") ?? "file").toLowerCase();
      if (type.startsWith("dir")) return `Crear la carpeta ${q(name)}`;
      if (type.endsWith("link") || type === "junction") return `Crear un enlace ${q(name)}`;
      return `Crear el archivo ${q(name)}`;
    },
  },
  {
    cmd: "mv|move|move-item|mi",
    values: ["-Path", "-LiteralPath", "-Destination", "-t", "--target-directory", "-S", "--suffix"],
    say: (a) => {
      const named = a.opt("-Path", "-LiteralPath");
      const all = named ? [named, ...a.positional] : [...a.positional];
      const to = a.opt("-Destination", "-t", "--target-directory") ?? all.pop();
      if (!to || all.length === 0) return null;
      if (all.length === 1 && sameFolder(all[0], to)) return `Renombrar ${q(base(all[0]))} a ${q(base(to))}`;
      return `Mover ${list(all, base)} a ${destination(to)}`;
    },
  },
  {
    cmd: "ren|rename|rename-item|rni",
    values: ["-Path", "-LiteralPath", "-NewName"],
    say: (a) => {
      const from = a.opt("-Path", "-LiteralPath") ?? a.positional[0];
      const to = a.opt("-NewName") ?? a.positional.at(-1);
      return from && to && from !== to ? `Renombrar ${q(base(from))} a ${q(base(to))}` : null;
    },
  },
  {
    cmd: "cp|copy|copy-item|cpi|xcopy|robocopy",
    values: ["-Path", "-LiteralPath", "-Destination", "-t", "--target-directory", "-Filter", "-Include", "-Exclude"],
    say: (a, c) => {
      const named = a.opt("-Path", "-LiteralPath");
      const all = named ? [named, ...a.positional] : [...a.positional];
      if (c.prog === "robocopy") {
        const [from, to] = all;
        if (!from || !to) return null;
        const mirror = a.has("/MIR", "/mir", "/PURGE", "/purge");
        return { text: `Copiar ${q(base(from))} a ${q(base(to))}${mirror ? " (espejo: borra lo que sobre en el destino)" : ""}`, danger: mirror };
      }
      const to = a.opt("-Destination", "-t", "--target-directory") ?? all.pop();
      if (!to || all.length === 0) return null;
      const recursive = a.has("-r", "-R", "--recursive", "-a", "--archive", "-recurse", "/s", "/S", "/e", "/E");
      return `Copiar ${list(all, base)}${recursive ? " con todo su contenido" : ""} a ${destination(to)}`;
    },
  },
  { cmd: "touch", values: ["-d", "--date", "-r", "--reference", "-t"], say: (a) => (a.positional.length ? `Crear el archivo ${list(a.positional, base)}` : null) },
  {
    cmd: "cat|type|get-content|gc|less|more|bat",
    values: ["-Path", "-LiteralPath", "-Tail", "-Head", "-TotalCount", "-First", "-Last", "-Encoding", "-Delimiter", "-ReadCount"],
    say: (a, c) => {
      const named = a.opt("-Path", "-LiteralPath");
      const files = named ? [named, ...a.positional] : a.positional;
      // `cat <<EOF > file`, or a filter in a pipe: its redirect says the rest.
      if (files.length === 0) return "";
      if (a.has("-Tail", "-Last")) return `Ver el final de ${list(files, base)}`;
      if (a.has("-Head", "-TotalCount", "-First")) return `Ver el principio de ${list(files, base)}`;
      if (c.prog === "type" && files.every((f) => !/[\\/.]/.test(f))) return null; // bash's `type cmd`, not cmd's `type file`
      return `Ver ${list(files, base)}`;
    },
  },
  {
    cmd: "head",
    values: ["-n", "-c", "--lines", "--bytes"],
    say: (a) => (a.positional.length ? `Ver el principio de ${list(a.positional, base)}` : null),
  },
  {
    cmd: "tail",
    values: ["-n", "-c", "--lines", "--bytes", "--pid", "-s", "--sleep-interval"],
    say: (a) => (a.positional.length ? `${a.has("-f", "-F", "--follow") ? "Seguir" : "Ver"} el final de ${list(a.positional, base)}` : null),
  },
  {
    cmd: "ls|dir|get-childitem|gci|ll|la|tree",
    values: ["-Path", "-LiteralPath", "-Filter", "-Include", "-Exclude", "-Depth", "-I", "-L", "--ignore", "--sort", "--color", "--time-style", "-w", "--width"],
    say: (a) => {
      const where = a.opt("-Path", "-LiteralPath") ?? a.positional.find((p) => !p.startsWith("/"));
      return where && where !== "." ? `Ver los archivos de ${q(base(where))}` : "Ver los archivos de la carpeta";
    },
  },
  { cmd: "pwd|get-location|gl", say: "Ver la carpeta actual" },
  {
    cmd: "grep|egrep|fgrep|rg|findstr|select-string|sls|ag",
    values: [
      "-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--context", "--include", "--exclude",
      "--exclude-dir", "-g", "--glob", "-t", "--type", "-T", "--type-not", "--color", "--colour",
      "-Pattern", "-Path", "-LiteralPath", "-Context", "-Encoding",
    ],
    say: (a, c) => {
      const pattern = a.opt("-e", "--regexp", "-Pattern") ?? a.positional[0];
      if (!pattern) return null;
      const named = a.opt("-Path", "-LiteralPath");
      const files = named ? [named] : a.positional.slice(a.opt("-e", "--regexp", "-Pattern") ? 0 : 1);
      if (files.length) return `Buscar ${q(pattern)} en ${list(files, base)}`;
      return c.piped ? `Filtrar por ${q(pattern)}` : `Buscar ${q(pattern)}`;
    },
  },
  { cmd: "wc", values: ["--files0-from"], say: (a) => (a.positional.length ? `Contar las líneas de ${list(a.positional, base)}` : "") },
  {
    cmd: "sed",
    values: ["-e", "--expression", "-f", "--file"],
    say: (a) => {
      if (!a.has("-i", "--in-place") && !a.words.some((w) => /^-i/.test(w) || w.startsWith("--in-place"))) return "";
      const files = a.positional.slice(a.opt("-e", "--expression", "-f", "--file") ? 0 : 1);
      return files.length ? `Editar ${list(files, base)} (reemplazar texto)` : null;
    },
  },
  { cmd: "chmod|chown|icacls|attrib", values: ["--reference"], say: (a) => (a.positional.length ? `Cambiar los permisos de ${q(base(a.positional.at(-1)!))}` : null) },
  { cmd: "ln", values: ["-t", "--target-directory", "-S", "--suffix"], say: (a) => (a.positional.length ? `Crear un enlace a ${q(base(a.positional[0]))}` : null) },
  { cmd: "unzip|expand-archive", values: ["-d", "-DestinationPath", "-Path", "-LiteralPath", "-x"], say: (a) => { const f = a.opt("-Path", "-LiteralPath") ?? a.positional[0]; return f ? `Descomprimir ${q(base(f))}` : null; } },
  {
    cmd: "tar",
    values: ["-f", "--file", "-C", "--directory", "--exclude", "-T", "--files-from"],
    say: (a) => {
      const file = a.opt("-f", "--file") ?? a.positional[0];
      if (!file) return null;
      const flags = a.words[0] && !a.words[0].startsWith("-") ? a.words[0] : "";
      if (a.has("-x", "--extract") || flags.includes("x")) return `Descomprimir ${q(base(file))}`;
      if (a.has("-c", "--create") || flags.includes("c")) return `Comprimir en ${q(base(file))}`;
      if (a.has("-t", "--list") || flags.includes("t")) return `Ver el contenido de ${q(base(file))}`;
      return null;
    },
  },
  { cmd: "code|code-insiders", say: (a) => (a.positional[0] ? `Abrir ${q(base(a.positional[0]))} en VS Code` : "Abrir VS Code") },
  {
    cmd: "echo|printf|write-host|write-output|true|:|exit|clear|cls|export|set|setx|source|.|select-object|select|where-object|foreach-object|%|?|sort-object|sort|uniq|cut|tr|awk|jq|format-table|ft|format-list|fl|out-string|out-null|measure-object|tee-object|xargs|column|nl|rev|base64|date|get-date|whoami|hostname|uname",
    // Known, and nothing worth a line by themselves: what they write into a file still shows.
    say: "",
  },
  { cmd: "out-file|set-content|sc|add-content|ac|tee", values: ["-FilePath", "-Path", "-LiteralPath", "-Encoding", "-Value", "-Width"], say: (a, c) => { const f = a.opt("-FilePath", "-Path", "-LiteralPath") ?? a.positional.find((p) => p !== "-a"); if (!f) return null; return /^(add-content|ac)$/.test(c.prog) || a.has("-Append", "-a", "--append") ? `Agregar al final de ${q(base(f))}` : `Escribir en ${q(base(f))}`; } },

  // ── Packages and runners ───────────────────────────────────────────────────
  { cmd: "npm|pnpm|yarn|bun ci", say: "Instalar las dependencias exactas del lockfile" },
  { cmd: "npm|pnpm|yarn|bun install|i|add|isntall", values: NPM_INSTALL_VALUES, say: install },
  { cmd: "npm|pnpm|yarn|bun uninstall|remove|rm|un|r", say: (a) => (a.positional.length ? `Desinstalar ${list(a.positional)}` : null) },
  { cmd: "npm|pnpm|yarn|bun run|run-script", values: ["-w", "--workspace", "--filter", "-F"], say: (a) => script(a.positional[0]) },
  { cmd: "npm|pnpm|yarn|bun test|t|tst", say: "Correr los tests" },
  { cmd: "npm|pnpm|yarn|bun start", say: "Correr el script \"start\"" },
  { cmd: "npm|pnpm|yarn|bun exec|dlx|x", say: (a) => (a.positional[0] ? `Ejecutar ${q(a.positional[0])} (paquete de npm)` : null) },
  { cmd: "npm|pnpm|yarn|bun publish", say: "Publicar el paquete en el registro de npm", danger: true },
  { cmd: "npm|pnpm|yarn|bun update|up|upgrade", say: (a) => (a.positional.length ? `Actualizar ${list(a.positional)}` : "Actualizar las dependencias") },
  { cmd: "npm|pnpm|yarn|bun audit", say: (a) => (a.positional[0] === "fix" ? "Actualizar dependencias con vulnerabilidades" : "Revisar las vulnerabilidades de las dependencias") },
  { cmd: "npm|pnpm|yarn|bun outdated", say: "Ver las dependencias desactualizadas" },
  { cmd: "npm|pnpm|yarn|bun ls|list|why", say: "Ver las dependencias instaladas" },
  { cmd: "npm|pnpm|yarn|bun init|create", say: "Crear un proyecto nuevo" },
  { cmd: "npm|pnpm|yarn|bun version", say: (a) => (a.positional[0] ? `Subir la versión del paquete (${a.positional[0]})` : "Ver la versión del paquete") },
  {
    cmd: "yarn workspace",
    say: (a) => {
      const [where, sub, ...rest] = a.positional;
      if (!where || !sub) return null;
      if (sub === "add" || sub === "install") return rest.length ? `Instalar ${list(rest)} en ${q(where)}` : `Instalar las dependencias de ${q(where)}`;
      return `Correr el script ${q(sub)} en ${q(where)}`;
    },
  },
  // `yarn build`, `pnpm dev`, `bun lint`: a script by its name. (npm needs `run`.)
  {
    cmd: "pnpm|yarn|bun",
    when: (a) => a.positional.length > 0 && !a.positional[0].includes("/") && !NOT_SCRIPTS.has(a.positional[0]),
    say: (a) => script(a.positional[0]),
  },
  { cmd: "yarn", say: (a) => (a.positional.length === 0 ? "Instalar las dependencias" : null) },
  { cmd: "npx|pnpx|bunx", values: ["-p", "--package", "-c", "--call"], say: (a) => (a.positional[0] ? `Ejecutar ${q(a.positional[0])} (paquete de npm)` : null) },
  {
    cmd: ["pip|pip3 install", "python|python3|py -m pip install", "uv pip install"],
    values: ["-r", "--requirement", "-e", "--editable", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-t", "--target", "--python"],
    say: (a) => {
      const req = a.opt("-r", "--requirement");
      if (req) return `Instalar las dependencias de ${q(base(req))}`;
      const editable = a.opt("-e", "--editable");
      if (editable) return editable === "." ? "Instalar el proyecto en modo editable" : `Instalar ${q(base(editable))} en modo editable`;
      if (a.positional.length === 0) return null;
      return a.has("-U", "--upgrade") ? `Actualizar ${list(a.positional)} con pip` : `Instalar ${list(a.positional)} con pip`;
    },
  },
  { cmd: ["pip|pip3 uninstall", "python|python3|py -m pip uninstall", "uv pip uninstall"], values: ["-r", "--requirement"], say: (a) => (a.positional.length ? `Desinstalar ${list(a.positional)}` : null) },
  { cmd: ["pip|pip3 list|freeze|show", "python|python3|py -m pip list|freeze|show", "uv pip list|freeze|show"], say: "Ver los paquetes de Python instalados" },
  { cmd: "uv add", values: ["--group", "--optional", "--extra", "-r", "--requirements"], say: (a) => (a.positional.length ? `Instalar ${list(a.positional)}` : null) },
  { cmd: "uv remove", values: ["--group", "--optional"], say: (a) => (a.positional.length ? `Desinstalar ${list(a.positional)}` : null) },
  { cmd: "uv sync|lock", say: "Instalar las dependencias" },
  { cmd: "uv venv", say: "Crear un entorno virtual" },
  { cmd: ["python|python3|py -m venv", "virtualenv"], say: (a) => `Crear un entorno virtual${a.positional.at(-1) ? ` en ${q(base(a.positional.at(-1)!))}` : ""}` },
  { cmd: ["pytest|py.test", "python|python3|py -m pytest"], values: ["-k", "-m", "-p", "--maxfail", "--rootdir", "-c", "--junitxml", "--tb", "-n", "--cov"], say: (a) => (a.positional.length ? `Correr los tests de ${list(a.positional, base)}` : "Correr los tests") },
  { cmd: "python|python3|py -m http.server", say: "Levantar un servidor web local" },
  { cmd: "python|python3|py -m", say: (a) => (a.positional[0] ? `Correr el módulo ${q(a.positional[0])} de Python` : null) },
  {
    cmd: "python|python3|py",
    values: ["-c", "-W", "-X"],
    say: (a) => {
      if (a.has("-c")) return "Correr código Python";
      return a.positional[0] ? `Correr ${q(base(a.positional[0]))} con Python` : null;
    },
  },
  { cmd: "node", values: ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--env-file"], say: (a) => (a.has("-e", "--eval", "-p", "--print") ? "Correr código JavaScript" : a.positional[0] ? `Correr ${q(base(a.positional[0]))} con Node` : null) },
  { cmd: "tsc", values: ["-p", "--project", "--outDir", "--target", "--module"], say: (a) => (a.has("--noEmit") ? "Revisar los tipos (TypeScript)" : "Compilar TypeScript") },
  { cmd: "vitest|jest|mocha", say: (a) => (a.positional[0] === "watch" ? "Correr los tests (modo watch)" : "Correr los tests") },
  { cmd: "eslint|prettier|biome|ruff|black|flake8|mypy", say: (a, c) => (/^(prettier|black)$/.test(c.prog) || a.has("--fix", "--write", "-w") || a.positional[0] === "format" ? "Formatear el código" : "Revisar el código") },
  { cmd: "cargo build|b", values: ["-p", "--package", "--target", "--features", "-F", "--bin", "--example", "-j", "--jobs", "--profile", "--target-dir"], say: (a) => { const p = a.opt("-p", "--package"); return `Compilar ${p ? q(p) : "el proyecto"}${a.has("-r", "--release") ? " en release" : ""} (Rust)`; } },
  { cmd: "cargo test|t", values: ["-p", "--package", "--target", "--features", "-F", "--test", "--bin", "-j", "--jobs", "--target-dir"], say: (a) => { const p = a.opt("-p", "--package"); return p ? `Correr los tests de ${q(p)} (Rust)` : "Correr los tests (Rust)"; } },
  { cmd: "cargo run|r", values: ["-p", "--package", "--bin", "--example", "--features", "-F", "--target-dir"], say: (a) => `Correr ${a.opt("--bin", "-p", "--package") ? q(a.opt("--bin", "-p", "--package")!) : "el programa"}${a.has("-r", "--release") ? " en release" : ""} (Rust)` },
  { cmd: "cargo check|c", say: "Revisar que el código compile (Rust)" },
  { cmd: "cargo clippy", say: "Revisar el código con clippy (Rust)" },
  { cmd: "cargo fmt", say: "Formatear el código (Rust)" },
  { cmd: "cargo add", values: ["-F", "--features", "--rename", "-p", "--package"], say: (a) => (a.positional.length ? `Agregar la dependencia ${list(a.positional)} (Rust)` : null) },
  { cmd: "cargo install", values: ["--version", "--git", "--path", "--root", "-F", "--features"], say: (a) => (a.positional.length ? `Instalar ${list(a.positional)} con cargo` : a.opt("--path") ? `Instalar ${q(base(a.opt("--path")!))} con cargo` : null) },
  { cmd: "cargo clean", say: "Borrar lo compilado (Rust)" },
  { cmd: "cargo update", say: "Actualizar las dependencias (Rust)" },
  { cmd: "go build", say: "Compilar (Go)" },
  { cmd: "go test", say: "Correr los tests (Go)" },
  { cmd: "go run", say: (a) => (a.positional[0] ? `Correr ${q(base(a.positional[0]))} (Go)` : "Correr el programa (Go)") },
  { cmd: "go get|install", say: (a) => (a.positional.length ? `Instalar ${list(a.positional)} (Go)` : null) },
  { cmd: "go mod tidy", say: "Ordenar las dependencias (Go)" },
  { cmd: "dotnet build", say: "Compilar (.NET)" },
  { cmd: "dotnet test", say: "Correr los tests (.NET)" },
  { cmd: "dotnet run", say: "Correr el programa (.NET)" },
  { cmd: "make|mingw32-make|just", values: ["-C", "-f", "--file", "-j", "--jobs"], say: (a, c) => (a.positional.length ? `Correr la tarea ${list(a.positional.filter((p) => !p.includes("=")))} (${c.prog})` : `Correr ${c.prog}`) },

  // ── Docker ─────────────────────────────────────────────────────────────────
  {
    cmd: ["docker compose up", "docker-compose up"],
    values: ["--scale", "-t", "--timeout", "--exit-code-from", "--pull", "--wait-timeout"],
    say: (a) => {
      const what = a.positional.length ? list(a.positional) : "los servicios";
      const verb = a.has("--build") ? "Reconstruir y levantar" : "Levantar";
      const bg = a.has("-d", "--detach") ? " en segundo plano" : "";
      return `${verb} ${what}${bg} (docker compose)`;
    },
  },
  {
    cmd: ["docker compose down", "docker-compose down"],
    values: ["--rmi", "-t", "--timeout"],
    say: (a) => {
      const volumes = a.has("-v", "--volumes");
      const images = a.has("--rmi");
      if (volumes || images) return { text: `Bajar los servicios y borrar sus ${volumes && images ? "volúmenes e imágenes" : volumes ? "volúmenes" : "imágenes"} (docker compose)`, danger: true };
      return "Bajar los servicios (docker compose)";
    },
  },
  { cmd: ["docker compose build", "docker-compose build"], say: (a) => `Construir ${a.positional.length ? list(a.positional) : "las imágenes"} (docker compose)` },
  { cmd: ["docker compose logs", "docker-compose logs"], values: ["--tail", "--since", "--until", "-n"], say: (a) => `Ver los logs${a.positional.length ? ` de ${list(a.positional)}` : ""} (docker compose)` },
  { cmd: ["docker compose ps", "docker-compose ps"], say: "Ver los servicios (docker compose)" },
  { cmd: ["docker compose restart", "docker-compose restart"], say: (a) => `Reiniciar ${a.positional.length ? list(a.positional) : "los servicios"} (docker compose)` },
  { cmd: ["docker compose stop", "docker-compose stop"], say: (a) => `Parar ${a.positional.length ? list(a.positional) : "los servicios"} (docker compose)` },
  { cmd: ["docker compose start", "docker-compose start"], say: (a) => `Arrancar ${a.positional.length ? list(a.positional) : "los servicios"} (docker compose)` },
  { cmd: ["docker compose exec|run", "docker-compose exec|run"], values: ["-e", "--env", "-u", "--user", "-w", "--workdir", "--entrypoint", "-p", "--publish", "-v", "--volume", "--name"], say: "Ejecutar un comando en el servicio {1} (docker compose)" },
  {
    cmd: ["docker run", "docker container run"],
    values: [
      "-p", "--publish", "-v", "--volume", "-e", "--env", "--name", "-w", "--workdir", "--network", "--net", "-u", "--user",
      "--entrypoint", "--env-file", "--mount", "-l", "--label", "--platform", "--restart", "-m", "--memory", "--cpus",
      "--add-host", "--gpus", "-h", "--hostname", "--pull", "--cidfile", "--device", "--ulimit", "--log-driver",
      "--log-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--tmpfs", "--dns", "--expose", "--health-cmd",
      "--ipc", "--pid", "--runtime", "--security-opt", "--cap-add", "--cap-drop", "--group-add", "--link", "-a", "--attach",
    ],
    say: (a) => {
      const image = a.positional[0];
      if (!image) return null;
      const bg = a.has("-d", "--detach") ? " en segundo plano" : "";
      const privileged = a.has("--privileged");
      return { text: `Correr un contenedor de ${q(image)}${bg}${privileged ? " con todos los privilegios" : ""}`, danger: privileged };
    },
  },
  {
    cmd: ["docker build", "docker buildx build", "docker image build"],
    values: ["-t", "--tag", "-f", "--file", "--build-arg", "--target", "--platform", "--network", "--secret", "--ssh", "--cache-from", "--cache-to", "--label", "--progress", "-o", "--output"],
    say: (a) => { const t = a.opt("-t", "--tag"); return t ? `Construir la imagen ${q(t)}` : "Construir una imagen de Docker"; },
  },
  { cmd: ["docker ps", "docker container ls"], say: "Ver los contenedores" },
  { cmd: ["docker images", "docker image ls"], say: "Ver las imágenes de Docker" },
  { cmd: "docker logs", values: ["--tail", "-n", "--since", "--until"], say: "Ver los logs de {1}" },
  { cmd: "docker exec", values: ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file"], say: "Ejecutar un comando en el contenedor {1}" },
  { cmd: "docker stop|kill", say: (a) => (a.positional.length ? `Detener ${list(a.positional)}` : null) },
  { cmd: "docker start|restart", say: (a) => (a.positional.length ? `Arrancar ${list(a.positional)}` : null) },
  { cmd: ["docker rm", "docker container rm"], say: (a) => (a.positional.length ? { text: `Eliminar el contenedor ${list(a.positional)}`, danger: true } : null) },
  { cmd: ["docker rmi", "docker image rm"], say: (a) => (a.positional.length ? { text: `Eliminar la imagen ${list(a.positional)}`, danger: true } : null) },
  { cmd: "docker volume rm", say: (a) => (a.positional.length ? { text: `Eliminar el volumen ${list(a.positional)} y sus datos`, danger: true } : null) },
  { cmd: "docker system|image|container|volume|network|builder prune", say: "Borrar todo lo que Docker no está usando", danger: true },
  { cmd: "docker pull", say: "Descargar la imagen {1}" },
  { cmd: "docker push", say: "Publicar la imagen {1}" },

  // ── Network ────────────────────────────────────────────────────────────────
  { cmd: "curl|invoke-webrequest|iwr|invoke-restmethod|irm", values: CURL_VALUES, say: web },
  { cmd: "wget", values: WGET_VALUES, say: web },
  { cmd: "ssh", values: ["-i", "-p", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-c", "-m", "-b", "-E", "-S", "-O", "-Q", "-w"], say: (a) => (a.positional[0] ? `Conectarse por SSH a ${q(host(a.positional[0].replace(/^[^@]*@/, "")))}` : null) },
  { cmd: "scp|rsync", values: ["-i", "-P", "-p", "-o", "-F", "-e", "--exclude", "--include", "--filter"], say: (a, c) => { const [from, to] = [a.positional.slice(0, -1), a.positional.at(-1)]; if (!to || from.length === 0) return null; const del = c.prog === "rsync" && a.has("--delete", "--delete-after", "--delete-before", "--delete-during"); return { text: `Copiar ${list(from, base)} a ${q(to.includes(":") ? to.split(":")[0].replace(/^[^@]*@/, "") : base(to))}${del ? " (borrando lo que sobre en el destino)" : ""}`, danger: del }; } },

  // ── Processes and the machine ──────────────────────────────────────────────
  { cmd: "ps|get-process|gps|tasklist|top|htop", say: "Ver los procesos" },
  { cmd: "kill|pkill|killall|taskkill|stop-process|spps", values: ["-s", "--signal", "/PID", "/pid", "/IM", "/im", "-Id", "-Name", "-ProcessName"], say: (a) => { const who = a.opt("/IM", "/im", "-Name", "-ProcessName") ?? a.opt("/PID", "/pid", "-Id") ?? a.positional[0]; return { text: who ? `Terminar el proceso ${q(who)}` : "Terminar un proceso", danger: true }; } },
  { cmd: "shutdown|reboot|restart-computer|stop-computer|poweroff", say: "Apagar o reiniciar la computadora", danger: true },
  { cmd: "sleep|start-sleep", values: ["-Seconds", "-s", "-Milliseconds", "-m"], say: (a) => { const s = a.opt("-Seconds", "-s") ?? a.positional[0]; return s && /^\d+(\.\d+)?$/.test(s) ? `Esperar ${s} s` : "Esperar"; } },
  {
    cmd: "which|where|get-command|gcm|command",
    // In a PowerShell pipe, `where` is Where-Object: a filter, nothing to say.
    say: (a, c) => (c.prog === "where" && c.piped ? "" : a.positional[0] ? `Ver dónde está ${q(a.positional[0])}` : null),
  },
  { cmd: "env|printenv|get-childitem env:", say: (a) => (a.positional.length === 0 ? "Ver las variables de entorno" : null) },
  { cmd: "open|start|start-process|invoke-item|ii|explorer|xdg-open", values: ["-FilePath", "-ArgumentList", "-WorkingDirectory"], say: (a) => { const t = a.opt("-FilePath") ?? a.positional.find((p) => p !== '""'); return t ? `Abrir ${q(/:\/\//.test(t) ? host(t) : base(t))}` : null; } },
];

// ── Matching a simple command against the rules ──────────────────────────────

/** A program as the rules name it: no folder, no extension, lower case. */
export function programName(word: string): string {
  const last = word.split(/[\\/]/).pop() || word;
  return last.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

interface Pattern {
  progs: Set<string>;
  subs: Set<string>[];
}

const compiled = new WeakMap<Rule, Pattern[]>();

function patternsOf(rule: Rule): Pattern[] {
  let found = compiled.get(rule);
  if (!found) {
    found = (Array.isArray(rule.cmd) ? rule.cmd : [rule.cmd]).map((text) => {
      const [prog, ...subs] = text.trim().split(/\s+/);
      const alts = (w: string) => new Set(w.split("|").map((x) => x.toLowerCase()));
      return { progs: alts(prog), subs: subs.map(alts) };
    });
    compiled.set(rule, found);
  }
  return found;
}

const isOption = (w: string) => w.length > 1 && w.startsWith("-");

/** Skips the options GLOBAL_OPTIONS knows for `key` (with their values), noting their values in `globals`. */
function skipGlobals(words: string[], i: number, key: string, globals: Map<string, string>): number {
  const known = GLOBAL_OPTIONS[key];
  if (!known) return i;
  while (i < words.length && isOption(words[i])) {
    const w = words[i];
    const eq = w.indexOf("=");
    const name = known.find((k) => sameOption(eq > 0 ? w.slice(0, eq) : w, k));
    if (!name) break;
    if (eq > 0) {
      globals.set(name, w.slice(eq + 1));
      i++;
    } else {
      globals.set(name, words[i + 1] ?? "");
      i += 2;
    }
  }
  return i;
}

/** Where `p`'s words end in `words`, or -1. Options between a program and its subcommand (`git -C x push`) are stepped over. */
function matchPattern(p: Pattern, words: string[], globals: Map<string, string>): number {
  const prog = programName(words[0] ?? "");
  if (!p.progs.has(prog)) return -1;
  let key = prog;
  let i = skipGlobals(words, 1, key, globals);
  for (const alts of p.subs) {
    while (i < words.length && !alts.has(words[i].toLowerCase()) && isOption(words[i])) {
      const before = i;
      i = skipGlobals(words, i, key, globals);
      if (i === before) i++; // an option this table does not know: step over it alone
    }
    if (i >= words.length || !alts.has(words[i].toLowerCase())) return -1;
    key = `${key} ${words[i].toLowerCase()}`;
    i = skipGlobals(words, i + 1, key, globals);
  }
  return i;
}

/** Fills a template; null when a placeholder has nothing to put in (the rule does not apply). */
function fill(template: string, a: Args, c: Ctx): string | null {
  let missing = false;
  const text = template.replace(/\{([^}:]+)(?::(\w+))?\}/g, (_, key: string, filter?: string) => {
    if (key === "branch") return c.branch();
    const show = (filter && FILTERS[filter]) || tidy;
    if (key === "all") {
      if (a.positional.length === 0) missing = true;
      return list(a.positional, show);
    }
    const value = /^\d+$/.test(key)
      ? a.positional[Number(key) - 1]
      : key === "last"
        ? a.positional.at(-1)
        : key.startsWith("-")
          ? a.opt(key)
          : undefined;
    if (value == null || value === "") {
      missing = true;
      return "";
    }
    return q(show(value));
  });
  return missing ? null : text;
}

// ── Explaining ───────────────────────────────────────────────────────────────

/** What explaining a whole command line keeps track of from one simple command to the next. */
interface Walk {
  /** Where the next command runs, relative to the session's folder: "" itself, null unknown. */
  dir: string | null;
  branchDirs: string[];
  branches: Branches | undefined;
  /** Branches an earlier part of the line switched a folder to (null: no longer known). */
  switched: Map<string, string | null>;
  parts: Part[];
}

/** At most this many parts in a line; it ends in "…" past them. */
const MAX_PARTS = 12;

/** Words that only steer the shell; the command follows them. */
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "nohup", "exec", "builtin", "noglob"]);
/** Commands that open a construct this does not follow: their part is skipped. */
const SKIPPED = new Set(["for", "case", "function", "fi", "done", "esac", "select"]);
/** Prefixes that run the rest of the line: `uv run pytest` is pytest. */
const RUNNERS: Record<string, readonly string[]> = { uv: ["run"], poetry: ["run"], pipenv: ["run"], pdm: ["run"], hatch: ["run"], rye: ["run"] };
const CD = new Set(["cd", "chdir", "set-location", "sl", "pushd"]);
const NOWHERE = /^(?:\/dev\/null|nul|\$null|\/dev\/stderr|\/dev\/stdout|-)$/i;

/** Joins a `cd` target onto a folder key; null when the target cannot be known from the text alone. */
function joinDir(dir: string | null, target: string): string | null {
  const t = target.trim();
  if (!t || /[$~%`*?]/.test(t) || t === "-") return null;
  if (/^(?:[\\/]|[A-Za-z]:[\\/]?)/.test(t)) return t;
  if (dir === null) return null;
  return dir === "" ? t : `${dir}/${t}`;
}

/** The words a simple command really starts at, past assignments, `sudo`, `env`, `xargs`… and whether `sudo` was among them. */
function stripPrefixes(input: string[]): { words: string[]; sudo: boolean; skip: boolean } {
  let words = input;
  let sudo = false;
  for (let guard = 0; guard < 16 && words.length; guard++) {
    const w = words[0];
    const prog = programName(w);
    if (SKIPPED.has(w)) return { words, sudo, skip: true };
    if (LEADING_KEYWORDS.has(w)) {
      words = words.slice(1);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      words = words.slice(1);
    } else if (prog === "sudo" || prog === "doas") {
      sudo = true;
      let i = 1;
      while (i < words.length && isOption(words[i])) i += /^-[ugpCDhrRTU]$/.test(words[i]) ? 2 : 1;
      words = words.slice(i);
    } else if (prog === "env" && words.length > 1) {
      let i = 1;
      while (i < words.length && (isOption(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i += /^-[uSC]$/.test(words[i]) ? 2 : 1;
      if (i >= words.length) break;
      words = words.slice(i);
    } else if (prog === "xargs" && words.length > 1) {
      let i = 1;
      while (i < words.length && isOption(words[i])) i += /^-[nIPLdasE]$/.test(words[i]) ? 2 : 1;
      if (i >= words.length) break;
      words = words.slice(i);
    } else if (prog === "timeout" && words.length > 2 && /^\d+(?:\.\d+)?[smhd]?$/.test(words[1])) {
      words = words.slice(2);
    } else if (prog === "nice" && words.length > 1) {
      words = words.slice(words[1] === "-n" ? 3 : 1);
    } else if (prog === "command" && words.length > 1 && !isOption(words[1])) {
      words = words.slice(1);
    } else if (RUNNERS[prog] && RUNNERS[prog].includes((words[1] ?? "").toLowerCase()) && words.length > 2) {
      let i = 2;
      while (i < words.length && isOption(words[i])) i += /^--(with|python|env-file|package|extra|group)$/.test(words[i]) ? 2 : 1;
      if (i >= words.length) break;
      words = words.slice(i);
    } else {
      break;
    }
  }
  return { words, sudo, skip: false };
}

/** `bash -c "…"`, `cmd /c …`, `powershell -Command …`: the script they run, or null. */
function innerScript(words: string[]): string | null {
  const prog = programName(words[0] ?? "");
  if (new RegExp(`^(?:${SHELLS})$`).test(prog)) {
    const i = words.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    return i > 0 && words[i + 1] !== undefined ? words[i + 1] : null;
  }
  if (prog === "cmd") {
    const i = words.findIndex((w, k) => k > 0 && /^\/[ck]$/i.test(w));
    return i > 0 && i + 1 < words.length ? words.slice(i + 1).join(" ") : null;
  }
  if (new RegExp(`^(?:${POWERSHELL})$`).test(prog)) {
    const i = words.findIndex((w, k) => k > 0 && /^-(?:c|command)$/i.test(w));
    return i > 0 && i + 1 < words.length ? words.slice(i + 1).join(" ") : null;
  }
  return null;
}

/** What a rule said. */
interface Saying {
  text: string;
  danger: boolean;
}

/** The first rule that has something to say about `words`, or the generic version / help lines. */
function sayFor(words: string[], piped: boolean, walk: Walk): Saying | null {
  const prog = programName(words[0]);
  const globals = new Map<string, string>();
  for (const rule of RULES) {
    for (const p of patternsOf(rule)) {
      globals.clear();
      const end = matchPattern(p, words, globals);
      if (end < 0) continue;
      const a = parseArgs(words.slice(end), rule.values, slashSwitch(prog));
      if (rule.when && !rule.when(a)) continue;
      // `git -C <dir> …` runs there, whatever the shell's folder.
      const runsIn = prog === "git" && globals.has("-C") ? joinDir(walk.dir, globals.get("-C")!) : walk.dir;
      const ctx: Ctx = {
        prog,
        piped,
        branch: () => {
          if (runsIn === null) return "la rama actual";
          if (walk.switched.has(runsIn)) {
            const now = walk.switched.get(runsIn);
            return now ? q(now) : "la rama actual";
          }
          if (!walk.branchDirs.includes(runsIn)) walk.branchDirs.push(runsIn);
          const known = walk.branches?.get(runsIn);
          return known ? q(known) : "la rama actual";
        },
      };
      const out = typeof rule.say === "string" ? fill(rule.say, a, ctx) : rule.say(a, ctx);
      if (out === null) continue;
      const ruleDanger = typeof rule.danger === "function" ? rule.danger(a) : !!rule.danger;
      if (typeof out === "string") return { text: out, danger: ruleDanger };
      if (out.branch !== undefined && runsIn !== null) walk.switched.set(runsIn, out.branch);
      return { text: out.text, danger: out.danger ?? ruleDanger };
    }
  }
  const rest = words.slice(1);
  if (rest.length === 1 && /^(?:--version|-V|-v|version)$/.test(rest[0])) return { text: `Ver la versión de ${q(prog)}`, danger: false };
  if (rest.length === 1 && /^(?:--help|-h|-\?|\/\?|help)$/.test(rest[0])) return { text: `Ver la ayuda de ${q(prog)}`, danger: false };
  return null;
}

/** `npx tool …`, `pnpm exec tool …`, `yarn dlx tool …`: the words of the tool they run, or null. */
function packageRunner(words: string[]): string[] | null {
  const prog = programName(words[0]);
  let i: number;
  if (prog === "npx" || prog === "pnpx" || prog === "bunx") i = 1;
  else if (/^(?:npm|pnpm|yarn|bun)$/.test(prog) && /^(?:exec|dlx|x)$/.test(words[1] ?? "")) i = 2;
  else return null;
  while (i < words.length && isOption(words[i])) i += /^(?:-p|--package|-c|--call)$/.test(words[i]) ? 2 : 1;
  return i < words.length ? words.slice(i) : null;
}

const SCRIPT_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "iex", "invoke-expression", "powershell", "pwsh", "python", "python3", "node"]);

function addPart(walk: Walk, text: string, danger: boolean) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) walk.parts.push({ text: clean, danger });
}

function explainSimple(simple: Simple, walk: Walk, depth: number) {
  const { words, sudo, skip } = stripPrefixes(simple.words);
  if (skip || words.length === 0) return;

  const script = depth < 3 ? innerScript(words) : null;
  if (script !== null) {
    walkCommand(script, walk, depth + 1);
    return;
  }

  const prog = programName(words[0]);
  const piped = simple.joinedBy === "|";

  // `curl … | sh`: whatever came down the pipe runs as a script.
  if (piped && SCRIPT_RUNNERS.has(prog) && words.slice(1).every((w) => isOption(w) || w === "-")) {
    addPart(walk, "Ejecutar lo recibido como un script", true);
    return;
  }

  // `npx vitest run` is vitest; `npx some-tool` the rule for npx.
  const runner = packageRunner(words);
  const said = (runner && sayFor(runner, piped, walk)) || sayFor(words, piped, walk);

  if (CD.has(prog)) {
    const a = parseArgs(words.slice(1), ["-Path", "-LiteralPath"], slashSwitch(prog));
    const target = a.opt("-Path", "-LiteralPath") ?? a.positional[0];
    walk.dir = target ? joinDir(walk.dir, target) : null;
  } else if (prog === "popd") {
    walk.dir = null;
  }

  if (!said) return; // unknown: skipped, and so is where its output goes
  if (said.text) addPart(walk, sudo ? `${said.text} (como administrador)` : said.text, said.danger || sudo);
  for (const w of simple.writes) {
    if (NOWHERE.test(w.file) || /^&?\d$/.test(w.file)) continue;
    addPart(walk, `${w.append ? "Agregar al final de" : "Escribir en"} ${q(base(w.file))}`, false);
  }
}

function walkCommand(command: string, walk: Walk, depth: number) {
  for (const simple of splitCommand(command)) {
    if (walk.parts.length > MAX_PARTS) break;
    explainSimple(simple, walk, depth);
  }
}

function finish(walk: Walk): Explanation | null {
  if (walk.parts.length === 0) return null;
  const parts = walk.parts.length > MAX_PARTS ? [...walk.parts.slice(0, MAX_PARTS), { text: "…", danger: false }] : walk.parts;
  return { parts, danger: walk.parts.some((p) => p.danger), branchDirs: walk.branchDirs };
}

/**
 * What a shell command line does — bash, PowerShell or cmd — or null when no
 * part of it is known. `branches` completes the parts that name a git branch
 * (see Explanation.branchDirs).
 */
export function explainCommand(command: string, branches?: Branches): Explanation | null {
  const walk: Walk = { dir: "", branchDirs: [], branches, switched: new Map(), parts: [] };
  walkCommand(command, walk, 0);
  return finish(walk);
}

/** One line about a file, page or query a non-shell tool asks for. */
const single = (text: string, danger = false): Explanation => ({ parts: [{ text, danger }], danger, branchDirs: [] });

/**
 * What a tool call that needs permission does: the shell tools through
 * explainCommand, the others in one line from their input. Null when there is
 * nothing to say.
 */
export function explainTool(tool: string, input: Record<string, unknown>, branches?: Branches): Explanation | null {
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ");
    }
    return null;
  };
  switch (tool) {
    case "Bash":
    case "PowerShell": {
      const command = input.command;
      return typeof command === "string" ? explainCommand(command, branches) : null;
    }
    case "Write": {
      const f = str("file_path", "path");
      return f ? single(`Escribir el archivo ${q(base(f))}`) : null;
    }
    case "Edit":
    case "MultiEdit": {
      const f = str("file_path", "path");
      return f ? single(`Editar el archivo ${q(base(f))}`) : null;
    }
    case "NotebookEdit": {
      const f = str("notebook_path", "file_path");
      return f ? single(`Editar el notebook ${q(base(f))}`) : null;
    }
    case "Read": {
      const f = str("file_path", "path");
      return f ? single(`Leer el archivo ${q(base(f))}`) : null;
    }
    case "LS": {
      const f = str("path");
      return f ? single(`Ver los archivos de ${q(base(f))}`) : null;
    }
    case "WebFetch": {
      const url = str("url");
      return url ? single(`Leer la página ${q(host(url))}`) : null;
    }
    case "WebSearch": {
      const query = str("query");
      return query ? single(`Buscar en la web ${q(query)}`) : null;
    }
    case "Glob": {
      const pattern = str("pattern");
      return pattern ? single(`Buscar archivos ${q(pattern)}`) : null;
    }
    case "Grep": {
      const pattern = str("pattern");
      return pattern ? single(`Buscar ${q(pattern)} en el código`) : null;
    }
    case "Task":
    case "Agent": {
      const what = str("description");
      return single(what ? `Lanzar un subagente: ${q(what)}` : "Lanzar un subagente");
    }
    case "TodoWrite":
      return single("Actualizar la lista de tareas");
    default: {
      const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? single(`Usar ${q(mcp[2])} (MCP ${q(mcp[1])})`) : null;
    }
  }
}

/**
 * The real folder behind a key of Explanation.branchDirs, from the session's
 * folder: "" is `cwd` itself, `../x` is resolved against it. Windows paths for a
 * Windows session (Git Bash's `/c/…` included), Linux paths for a WSL one.
 * Null when it cannot be told.
 */
export function resolveFolder(cwd: string, key: string, linux: boolean): string | null {
  if (!cwd) return null;
  if (linux) {
    if (!cwd.startsWith("/")) return null;
    const full = key.startsWith("/") ? key : key ? `${cwd}/${key}` : cwd;
    const out: string[] = [];
    for (const part of full.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return `/${out.join("/")}`;
  }
  let path = key;
  const gitBash = path.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (gitBash) path = `${gitBash[1].toUpperCase()}:\\${gitBash[2] ?? ""}`;
  const root = (p: string) => p.match(/^(?:[A-Za-z]:|\\\\[^\\/]+[\\/][^\\/]+)/)?.[0] ?? null;
  const cwdRoot = root(cwd);
  if (!cwdRoot) return null;
  let full: string;
  if (root(path)) full = path;
  else if (/^[\\/]/.test(path)) full = cwdRoot + path;
  else full = path ? `${cwd}\\${path}` : cwd;
  const prefix = root(full)!;
  const out: string[] = [];
  for (const part of full.slice(prefix.length).split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${prefix}\\${out.join("\\")}`;
}
