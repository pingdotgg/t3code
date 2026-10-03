import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  parse,
  type Command,
  type DoubleQuotedChild,
  type HereDoc,
  type Word,
  type WordPart,
} from "unbash";

/**
 * Code in another language inside a shell command: a `bash -lc "…"` script, a
 * `python3 -c '…'` argument, or a heredoc fed to an interpreter or written to
 * a file. `starts[i]` and `ends[i]` are the span of the original command that
 * spells `text[i]`, so a quoted `\"` maps back to both of its characters.
 */
export interface EmbeddedScript {
  readonly language: string;
  readonly text: string;
  readonly starts: ReadonlyArray<number>;
  readonly ends: ReadonlyArray<number>;
}

interface MappedText {
  readonly text: string;
  readonly starts: ReadonlyArray<number>;
  readonly ends: ReadonlyArray<number>;
}

interface Interpreter {
  readonly language: string;
  /** Flags whose next argument is the script. */
  readonly inline: (flag: string) => boolean;
  /** Options that consume the next argument. */
  readonly valueOptions?: ReadonlySet<string>;
  /** Options after which the script comes from a file or module instead. */
  readonly scriptFileOptions?: ReadonlySet<string>;
  /** "always" for SQL shells, which read statements from stdin next to their database argument. */
  readonly stdin: "always" | "without-script-file" | "never";
  /** The first positional argument holding a script, as in `sqlite3 app.db "select 1"`. */
  readonly positionalScript?: number;
  /** SQL shells run every `-c` and every statement argument, in order. */
  readonly repeatable?: boolean;
  readonly subcommand?: string;
  /** PowerShell matches parameters case-insensitively; the lists above are lowercase. */
  readonly ignoreCase?: boolean;
}

const MAX_DEPTH = 4;

const flagIn =
  (...flags: string[]) =>
  (flag: string) =>
    flags.includes(flag);

const SHELL: Interpreter = {
  language: "shellscript",
  inline: (flag) => /^-[a-z]*c[a-z]*$/u.test(flag),
  valueOptions: new Set(["-o", "-O", "--rcfile", "--init-file"]),
  stdin: "without-script-file",
};

const PYTHON: Interpreter = {
  language: "python",
  inline: flagIn("-c"),
  valueOptions: new Set(["-W", "-X"]),
  scriptFileOptions: new Set(["-m"]),
  stdin: "without-script-file",
};

const SQL_SHELL: Interpreter = {
  language: "sql",
  inline: flagIn("-c", "--command", "-e", "--execute", "-cmd"),
  valueOptions: new Set([
    "-d",
    "-h",
    "-u",
    "-U",
    "--dbname",
    "--host",
    "--user",
    "--username",
    "-separator",
    "-nullvalue",
    "-init",
  ]),
  scriptFileOptions: new Set(["-f", "--file"]),
  stdin: "always",
  repeatable: true,
};

const INTERPRETERS: Record<string, Interpreter> = {
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  dash: SHELL,
  ash: SHELL,
  ksh: SHELL,
  fish: { language: "fish", inline: flagIn("-c", "--command"), stdin: "without-script-file" },
  node: {
    language: "javascript",
    inline: flagIn("-e", "--eval", "-p", "--print"),
    valueOptions: new Set(["-r", "--require", "--import", "--loader", "-C", "--conditions"]),
    stdin: "without-script-file",
  },
  bun: { language: "typescript", inline: flagIn("-e", "--eval", "-p", "--print"), stdin: "never" },
  deno: {
    language: "typescript",
    inline: () => false,
    valueOptions: new Set(["-c", "--config", "--import-map", "--ext", "--env-file"]),
    stdin: "never",
    subcommand: "eval",
  },
  ruby: {
    language: "ruby",
    inline: flagIn("-e"),
    valueOptions: new Set(["-r"]),
    stdin: "without-script-file",
  },
  perl: { language: "perl", inline: flagIn("-e", "-E"), stdin: "without-script-file" },
  osascript: {
    language: "applescript",
    inline: flagIn("-e"),
    valueOptions: new Set(["-l", "-s"]),
    stdin: "without-script-file",
  },
  pwsh: {
    language: "powershell",
    inline: flagIn("-c", "-command"),
    valueOptions: new Set(["-executionpolicy", "-workingdirectory", "-windowstyle"]),
    scriptFileOptions: new Set(["-f", "-file", "-encodedcommand"]),
    stdin: "never",
    ignoreCase: true,
  },
  psql: SQL_SHELL,
  mysql: SQL_SHELL,
  mariadb: SQL_SHELL,
  sqlite3: { ...SQL_SHELL, positionalScript: 1 },
  duckdb: { ...SQL_SHELL, positionalScript: 1 },
};
INTERPRETERS.powershell = INTERPRETERS.pwsh!;

// Commands that run the next word as the program, with the options that consume a value.
const PROGRAM_WRAPPERS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-D", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  nohup: new Set(),
  exec: new Set(["-a"]),
  command: new Set(),
  builtin: new Set(),
};

// Heredoc delimiters that name their language, as in `<<'SQL'`.
const DELIMITER_LANGUAGES: Record<string, string> = {
  py: "python",
  python: "python",
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  rb: "ruby",
  ruby: "ruby",
  html: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  diff: "diff",
  patch: "diff",
};

/**
 * The scripts embedded in a shell command, outermost first, so a highlighter
 * painting them in order lets a nested script override the one containing it.
 * Returns nothing for a command that does not parse cleanly; where a broken
 * quote ends cannot be trusted.
 */
export function embeddedScripts(command: string): EmbeddedScript[] {
  const identity = Array.from({ length: command.length }, (_, index) => index);
  return scriptsIn(
    { text: command, starts: identity, ends: identity.map((index) => index + 1) },
    0,
  );
}

function scriptsIn(source: MappedText, depth: number): EmbeddedScript[] {
  const script = parse(source.text);
  if (script.errors?.length) return [];
  const found: EmbeddedScript[] = [];
  forEachCommand(script.commands, (command) => {
    for (const { language, mapped } of commandScripts(command, source.text)) {
      if (mapped.text.trim() === "") continue;
      const embedded: EmbeddedScript = {
        language,
        text: mapped.text,
        starts: mapped.starts.map((start) => source.starts[start]!),
        ends: mapped.ends.map((end) => source.ends[end - 1]!),
      };
      found.push(embedded);
      if (language === "shellscript" && depth + 1 < MAX_DEPTH) {
        found.push(...scriptsIn(embedded, depth + 1));
      }
    }
  });
  return found;
}

function isNode(value: unknown): value is { readonly type: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

/** Visits every simple command, including those inside `$(…)`, loops and subshells. */
function forEachCommand(
  node: unknown,
  visit: (command: Command) => void,
  seen = new WeakSet<object>(),
): void {
  if (Array.isArray(node)) {
    for (const child of node) forEachCommand(child, visit, seen);
    return;
  }
  if (!isNode(node) || seen.has(node)) return;
  seen.add(node);
  switch (node.type) {
    case "Command":
      visit(node as Command);
      break;
    case "CommandExpansion":
    case "ProcessSubstitution": {
      const { script } = node as Extract<WordPart, { type: "CommandExpansion" }>;
      // Escaped-backtick scripts own a decoded source their positions index.
      if (script && !script.errors?.length && script.source === undefined) {
        forEachCommand(script.commands, visit, seen);
      }
      return;
    }
  }
  // Word parts are lazy getters, which Object.values skips.
  if ("parts" in node) forEachCommand(node.parts, visit, seen);
  for (const value of Object.values(node)) {
    if (typeof value === "object") forEachCommand(value, visit, seen);
  }
}

function programName(word: Word): string {
  return (word.value.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");
}

function interpreterFor(name: string): Interpreter | undefined {
  if (/^python(?:\d+(?:\.\d+)?)?$|^pypy3?$/u.test(name)) return PYTHON;
  return Object.hasOwn(INTERPRETERS, name) ? INTERPRETERS[name] : undefined;
}

/** Skips `env FOO=1`, `sudo -u bob` and similar to the word naming the real program. */
function programIndex(words: ReadonlyArray<Word>): number {
  let index = 0;
  while (index < words.length) {
    const name = programName(words[index]!);
    if (!Object.hasOwn(PROGRAM_WRAPPERS, name)) return index;
    const valueOptions = PROGRAM_WRAPPERS[name]!;
    index += 1;
    let optionsEnded = false;
    while (index < words.length) {
      const value = words[index]!.value;
      const isOption = !optionsEnded && value.startsWith("-");
      if (isOption && value === "--") optionsEnded = true;
      // `env -- FOO=1 cmd` still takes assignments after the options end.
      if (isOption || /^[A-Za-z_]\w*=/u.test(value)) {
        index += isOption && valueOptions.has(value) ? 2 : 1;
      } else {
        break;
      }
    }
  }
  return index;
}

function commandScripts(
  command: Command,
  source: string,
): Array<{ language: string; mapped: MappedText }> {
  if (!command.name) return [];
  const words = [command.name, ...command.args.filter((arg): arg is Word => arg.type === "Word")];
  const index = programIndex(words);
  const program = words[index];
  if (!program) return [];
  const name = programName(program);
  const interpreter = interpreterFor(name);
  const args = words.slice(index + 1);
  const scripts: Array<{ language: string; mapped: MappedText }> = [];

  let readsStdinScript = false;
  if (interpreter) {
    const found = interpreterArgs(interpreter, args);
    for (const script of found.scripts) {
      const mapped = wordText(script.word, source);
      if (!mapped) continue;
      const start = script.inValue ? mapped.text.indexOf("=") + 1 : 0;
      scripts.push({ language: interpreter.language, mapped: sliceMapped(mapped, start) });
    }
    readsStdinScript =
      interpreter.stdin !== "never" && found.scripts.length === 0 && !found.scriptFromFile;
  }

  const stdinLanguage = readsStdinScript ? interpreter?.language : undefined;
  const writtenLanguage = writtenFileLanguage(name, command, args);
  for (const redirect of command.redirects) {
    const toStdin = isDescriptor(redirect.descriptor, 0);
    if (redirect.type === "HereString" && toStdin && stdinLanguage && redirect.target) {
      const mapped = wordText(redirect.target, source);
      if (mapped) scripts.push({ language: stdinLanguage, mapped });
    }
    if (redirect.type === "HereDoc") {
      const language =
        (toStdin ? (stdinLanguage ?? writtenLanguage) : undefined) ?? delimiterLanguage(redirect);
      if (language) scripts.push({ language, mapped: hereDocText(redirect, source) });
    }
  }
  return scripts;
}

/** Whether a redirection without a descriptor, or with `fd`, targets file descriptor `fd`. */
function isDescriptor(descriptor: HereDoc["descriptor"], fd: number): boolean {
  return (
    descriptor === undefined || (descriptor.type === "FileDescriptor" && descriptor.value === fd)
  );
}

interface ScriptArgument {
  readonly word: Word;
  /** The script follows the `=` of `--eval=…` rather than filling the word. */
  readonly inValue: boolean;
}

/** The script arguments, and whether the script comes from a file instead. */
function interpreterArgs(
  interpreter: Interpreter,
  args: ReadonlyArray<Word>,
): { scripts: ScriptArgument[]; scriptFromFile: boolean } {
  const positionals: Word[] = [];
  const scripts: ScriptArgument[] = [];
  const whole = (word: Word): ScriptArgument => ({ word, inValue: false });
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = interpreter.ignoreCase ? arg.value.toLowerCase() : arg.value;
    if (!optionsEnded && flag === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && flag.startsWith("-") && flag !== "-") {
      // `--eval=code` and `--file=path` carry their value in the same word.
      const [name = flag, value] = flag.startsWith("--") ? flag.split(/=(.*)/su) : [flag];
      if (interpreter.scriptFileOptions?.has(name)) return { scripts, scriptFromFile: true };
      if (interpreter.inline(name)) {
        const next = args[index + 1];
        if (value !== undefined) scripts.push({ word: arg, inValue: true });
        else if (next) scripts.push(whole(next));
        if (!interpreter.repeatable) return { scripts, scriptFromFile: false };
        if (value === undefined) index += 1;
        continue;
      }
      if (value === undefined && interpreter.valueOptions?.has(flag)) index += 1;
      continue;
    }
    positionals.push(arg);
    // An interpreter stops reading its own options at the script file.
    if (interpreter.stdin === "without-script-file" && !interpreter.subcommand) break;
  }

  if (interpreter.subcommand) {
    if (positionals[0]?.value !== interpreter.subcommand) return { scripts, scriptFromFile: true };
    return { scripts: positionals.slice(1, 2).map(whole), scriptFromFile: false };
  }
  if (interpreter.positionalScript !== undefined) {
    scripts.push(...positionals.slice(interpreter.positionalScript).map(whole));
  }
  // SQL shells take databases as positional arguments, not script files.
  if (interpreter.stdin === "always") return { scripts, scriptFromFile: false };
  const first = positionals[0];
  return { scripts, scriptFromFile: first !== undefined && first.value !== "-" };
}

function sliceMapped(mapped: MappedText, start: number): MappedText {
  if (start === 0) return mapped;
  return {
    text: mapped.text.slice(start),
    starts: mapped.starts.slice(start),
    ends: mapped.ends.slice(start),
  };
}

/** The language of the file `cat > file` or `tee file` writes its stdin to. */
function writtenFileLanguage(
  name: string,
  command: Command,
  args: ReadonlyArray<Word>,
): string | undefined {
  let path: string | undefined;
  if (name === "cat") {
    for (const redirect of command.redirects) {
      if (
        redirect.type === "Redirect" &&
        [">", ">>", ">|", "&>", "&>>"].includes(redirect.operator) &&
        isDescriptor(redirect.descriptor, 1)
      ) {
        path = redirect.target?.value;
      }
    }
  } else if (name === "tee") {
    path = args.find((arg) => !arg.value.startsWith("-"))?.value;
  }
  if (!path) return undefined;
  const language = getFiletypeFromFileName(path);
  return language === "text" ? undefined : language;
}

function delimiterLanguage(hereDoc: HereDoc): string | undefined {
  const name = hereDoc.delimiter?.value.toLowerCase();
  return name && Object.hasOwn(DELIMITER_LANGUAGES, name) ? DELIMITER_LANGUAGES[name] : undefined;
}

/** A heredoc body as written; the interpreter reads its characters one to one. */
function hereDocText(hereDoc: HereDoc, source: string): MappedText {
  const { pos, end } = hereDoc.body;
  const starts = Array.from({ length: end - pos }, (_, index) => pos + index);
  return {
    text: source.slice(pos, end),
    starts,
    ends: starts.map((start) => start + 1),
  };
}

/**
 * A word's value with the source span of each character: quotes removed and
 * escapes resolved, the way the program receives it. Expansions such as
 * `$HOME` stay as written. Returns undefined for spellings it cannot map.
 */
function wordText(word: Word, source: string): MappedText | undefined {
  const builder = new MappedTextBuilder();
  const parts: ReadonlyArray<WordPart> = word.parts ?? [
    { type: "Literal", pos: word.pos, end: word.end, text: word.text, value: word.value },
  ];
  for (const part of parts) {
    switch (part.type) {
      case "Literal":
        if (!builder.addEscaped(part, false)) return undefined;
        break;
      case "SingleQuoted":
        builder.addRaw(part.value, part.pos + 1);
        break;
      case "DoubleQuoted":
      case "LocaleString":
        for (const child of part.parts) {
          if (!builder.addDoubleQuotedChild(child)) return undefined;
        }
        break;
      case "AnsiCQuoted":
        // $'…' escapes such as \x41 do not map character for character.
        if (part.value !== part.text.slice(2, -1)) return undefined;
        builder.addRaw(part.value, part.pos + 2);
        break;
      default:
        builder.addRaw(source.slice(part.pos, part.end), part.pos);
    }
  }
  return builder.build();
}

class MappedTextBuilder {
  private text = "";
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  addRaw(text: string, pos: number) {
    for (let index = 0; index < text.length; index += 1) this.push(text[index]!, pos + index, 1);
  }

  addDoubleQuotedChild(child: DoubleQuotedChild): boolean {
    if (child.type === "Literal") return this.addEscaped(child, true);
    this.addRaw(child.text, child.pos);
    return true;
  }

  /** Adds a literal, resolving backslash escapes; false when the result disagrees with the parser. */
  addEscaped(literal: { pos: number; text: string; value: string }, doubleQuoted: boolean) {
    const before = this.text.length;
    const { text, pos } = literal;
    for (let index = 0; index < text.length; index += 1) {
      const next = text[index + 1];
      if (
        text[index] === "\\" &&
        next !== undefined &&
        (!doubleQuoted || '$`"\\\n'.includes(next))
      ) {
        // A backslash-newline joins lines and spells nothing.
        if (next !== "\n") this.push(next, pos + index, 2);
        index += 1;
      } else {
        this.push(text[index]!, pos + index, 1);
      }
    }
    return this.text.slice(before) === literal.value;
  }

  build(): MappedText {
    return { text: this.text, starts: this.starts, ends: this.ends };
  }

  private push(character: string, start: number, length: number) {
    this.text += character;
    this.starts.push(start);
    this.ends.push(start + length);
  }
}
