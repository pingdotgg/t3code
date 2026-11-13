// The Cursor SDK walks from the workspace up to / for rules, then keeps only those inside the
// workspace, so ~/.cursor/rules and parent AGENTS.md / CLAUDE.md never reach the model.
// This restores exactly that dropped part of the walk, mirroring the SDK's LocalCursorRulesService.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// Cursor truncates (rather than skips) markdown rules past this many UTF-8 bytes.
const MAX_RULE_BYTES = 102_400;
const MAX_DESCRIPTION_CHARS = 1536;
const MAX_RULES_DIRECTORY_DEPTH = 10;
const MAX_RULES_DIRECTORY_ENTRIES = 1000;
const MAX_RULE_FILES = 100;
// Within one directory the SDK reads these after .cursor/rules, in this order.
const MARKDOWN_RULE_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"] as const;

/** Tests only: the last directory the walk reads, so fixtures ignore the host's real ancestors. */
export const CursorRulesWalkStop = Context.Reference<string | undefined>(
  "@t3tools/provider-cursor/CursorRulesWalkStop",
  { defaultValue: () => undefined },
);

type CursorRule =
  | { readonly kind: "always"; readonly path: string; readonly body: string }
  | { readonly kind: "globs"; readonly path: string; readonly globs: ReadonlyArray<string> }
  | { readonly kind: "described"; readonly path: string; readonly description: string };

const isQuoted = (value: string) =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));

/** Cursor's frontmatter value: bare true/false are booleans, surrounding quotes are stripped. */
function cursorValue(raw: string): string | boolean {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return isQuoted(value) ? value.slice(1, -1) : value;
}

/**
 * Port of the SDK's `.mdc` parser (not YAML), quirks included: the block ends at the next `---`
 * anywhere, and indented `- item` lines fill only `globs:` or a `metadata:` child left empty.
 * It skips the SDK's comma-splitting of `metadata.environments`-style keys, which rules never read.
 */
function parseCursorRuleFile(contents: string):
  | {
      readonly frontmatter: Record<string, string | boolean | Array<string>>;
      readonly body: string;
    }
  | undefined {
  const text = contents.trimStart();
  if (!text.startsWith("---")) return undefined;
  const parts = text.split("---").filter(Boolean);
  if (parts.length < 2) return undefined;
  const frontmatter: Record<string, string | boolean | Array<string>> = {};
  let parent: string | undefined;
  let listKey: string | undefined;
  for (const rawLine of (parts[0] ?? "").trim().split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey !== undefined) {
      const value = (item[1] ?? "").trim();
      const list = frontmatter[listKey];
      if (Array.isArray(list)) list.push(isQuoted(value) ? value.slice(1, -1) : value);
      continue;
    }
    if (parent !== undefined && (line.startsWith("  ") || line.startsWith("\t"))) {
      const entry = line.trim();
      const separator = entry.indexOf(":");
      if (separator === -1) continue;
      const key = `${parent}.${entry.slice(0, separator).trim()}`;
      const value = entry.slice(separator + 1).trim();
      frontmatter[key] = value === "" ? [] : cursorValue(value);
      listKey = value === "" ? key : undefined;
      continue;
    }
    parent = undefined;
    listKey = undefined;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "metadata" && value === "") {
      parent = key;
    } else if (key === "globs" && value === "") {
      frontmatter.globs = [];
      listKey = key;
    } else {
      frontmatter[key] = cursorValue(value);
    }
  }
  return { frontmatter, body: parts.slice(1).join("---").trim() };
}

/** Cursor splits a globs string on commas outside `{...}`. */
function cursorGlobs(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value
      .filter((glob) => typeof glob === "string")
      .map((glob) => glob.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const globs: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{") depth += 1;
    else if (char === "}" && depth > 0) depth -= 1;
    else if (char === "," && depth === 0) {
      globs.push(value.slice(start, index));
      start = index + 1;
    }
  }
  const rest = value.slice(start);
  globs.push(...(depth > 0 ? rest.split(",") : [rest]));
  return globs.map((glob) => glob.trim()).filter(Boolean);
}

/** Classifies an .mdc rule as the SDK's toCursorRule does; manual rules return `undefined`. */
function classifyMdcRule(path: string, contents: string): CursorRule | undefined {
  // Without a frontmatter block the SDK does not load an .mdc file at all.
  const parsed = parseCursorRuleFile(contents);
  if (parsed === undefined) return undefined;
  const data = parsed.frontmatter;
  if (data.alwaysApply === true) return { kind: "always", path, body: parsed.body };
  const globs = cursorGlobs(data.globs);
  if (globs.length > 0) return { kind: "globs", path, globs };
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description.length > 0) {
    return { kind: "described", path, description: description.slice(0, MAX_DESCRIPTION_CHARS) };
  }
  return undefined;
}

const decoder = new TextDecoder();

export const readCursorRulesAboveWorkspace = Effect.fn("readCursorRulesAboveWorkspace")(function* (
  workspaceRoot: string,
  stopAt?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isInside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const realPath = (file: string) =>
    fileSystem.realPath(file).pipe(Effect.map(path.normalize), Effect.option);
  const realRoot = Option.getOrElse(yield* realPath(workspaceRoot), () =>
    path.resolve(workspaceRoot),
  );

  /** At most 100 KB plus Cursor's truncation notice; `undefined` when unreadable. */
  const readRuleText = Effect.fn("readCursorRulesAboveWorkspace.readRuleText")(
    function* (file: string) {
      const info = yield* fileSystem.stat(file);
      if (info.type !== "File") return undefined;
      const size = Number(info.size);
      const handle = yield* fileSystem.open(file);
      // One read may return fewer bytes than asked (e.g. network filesystems).
      const chunks: Array<Uint8Array> = [];
      let remaining = Math.min(size, MAX_RULE_BYTES + 1);
      while (remaining > 0) {
        const chunk = yield* handle.readAlloc(remaining);
        if (Option.isNone(chunk)) break;
        chunks.push(chunk.value);
        remaining -= chunk.value.length;
      }
      const bytes = Buffer.concat(chunks);
      if (size <= MAX_RULE_BYTES) return decoder.decode(bytes).replace(/^\uFEFF/, "");
      let end = MAX_RULE_BYTES;
      while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      const notice = `[truncated: ${path.basename(file)} is ${Math.round(size / 1024)} KB; only the first 100 KB is included]`;
      return `${decoder.decode(bytes.subarray(0, end)).replace(/^\uFEFF/, "")}\n\n${notice}`;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );

  /** `.mdc` files below a `.cursor/rules` directory, sorted by relative path; symlinks followed. */
  const listMdcFiles = Effect.fn("readCursorRulesAboveWorkspace.listMdcFiles")(function* (
    rulesDirectory: string,
  ) {
    const files: Array<string> = [];
    let remainingEntries = MAX_RULES_DIRECTORY_ENTRIES;
    const visit = Effect.fnUntraced(function* (
      directory: string,
      depth: number,
    ): Effect.fn.Return<void> {
      const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.toSorted()) {
        if (remainingEntries <= 0) return;
        remainingEntries -= 1;
        const entry = path.join(directory, name);
        const info = yield* fileSystem.stat(entry).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          if (depth < MAX_RULES_DIRECTORY_DEPTH) yield* visit(entry, depth + 1);
        } else if (info.value.type === "File" && name.endsWith(".mdc")) {
          files.push(entry);
        }
      }
    });
    yield* visit(rulesDirectory, 0);
    return files.toSorted((left, right) =>
      path.relative(rulesDirectory, left).localeCompare(path.relative(rulesDirectory, right)),
    );
  });

  // The SDK walks each level closest-first: .cursor/rules, then CLAUDE.md, CLAUDE.local.md, AGENTS.md.
  const candidates: Array<{ readonly file: string; readonly markdown: boolean }> = [];
  const lastDirectory = stopAt === undefined ? undefined : path.resolve(stopAt);
  let directory = path.resolve(workspaceRoot);
  while (path.dirname(directory) !== directory && directory !== lastDirectory) {
    directory = path.dirname(directory);
    for (const file of yield* listMdcFiles(path.join(directory, ".cursor", "rules"))) {
      candidates.push({ file, markdown: false });
    }
    for (const name of MARKDOWN_RULE_FILES) {
      candidates.push({ file: path.join(directory, name), markdown: true });
    }
  }

  const loaded: Array<{ readonly rule: CursorRule; readonly real?: string }> = [];
  for (const { file, markdown } of candidates) {
    if (loaded.length >= MAX_RULE_FILES) break;
    const real = yield* realPath(file);
    // The SDK already loads (and keeps) everything that resolves into the workspace.
    if (Option.isNone(real) || isInside(real.value, realRoot)) continue;
    const text = yield* readRuleText(file);
    if (text === undefined) continue;
    const rule = markdown
      ? { kind: "always" as const, path: file, body: text.trim() }
      : classifyMdcRule(file, text);
    if (rule === undefined || (rule.kind === "always" && rule.body.length === 0)) continue;
    loaded.push(markdown ? { rule, real: real.value } : { rule });
  }
  return renderCursorRules(dropDuplicateMarkdownRules(loaded, path));
});

/**
 * Like the SDK, keeps one copy of markdown rules that share a file or trimmed content, preferring
 * the shallowest directory and AGENTS.md within one, while keeping the walk order.
 */
function dropDuplicateMarkdownRules(
  loaded: ReadonlyArray<{ readonly rule: CursorRule; readonly real?: string }>,
  path: Path.Path,
): ReadonlyArray<CursorRule> {
  const depth = (file: string) => file.split(/[\\/]+/).filter(Boolean).length;
  const isAgents = (file: string) => path.basename(file) === "AGENTS.md";
  const markdown = loaded
    .filter((entry) => entry.real !== undefined)
    .toSorted(
      (left, right) =>
        depth(path.dirname(left.rule.path)) - depth(path.dirname(right.rule.path)) ||
        Number(isAgents(right.rule.path)) - Number(isAgents(left.rule.path)),
    );
  const identities = new Set<string>();
  const dropped = new Set<CursorRule>();
  for (const { rule, real } of markdown) {
    const keys = [`file:${real}`, `text:${rule.kind === "always" ? rule.body : ""}`];
    if (keys.some((key) => identities.has(key))) dropped.add(rule);
    else for (const key of keys) identities.add(key);
  }
  return loaded.flatMap(({ rule }) => (dropped.has(rule) ? [] : [rule]));
}

/** Sent once when a conversation was given rules that no longer exist. */
export const CURSOR_RULES_REMOVED_NOTICE =
  "<user_rules>\nThe user removed the Cursor rules from the folders above this workspace. Stop following any earlier <user_rules> block.\n</user_rules>";

function renderCursorRules(rules: ReadonlyArray<CursorRule>): string | undefined {
  const sections: Array<string> = [];
  const requestable: Array<string> = [];
  for (const rule of rules) {
    if (rule.kind === "always") {
      sections.push(`<rule path="${rule.path}">\n${rule.body.replace(/\r\n/g, "\n")}\n</rule>`);
    } else if (rule.kind === "globs") {
      requestable.push(`- ${rule.path} (applies to files matching ${rule.globs.join(", ")})`);
    } else {
      requestable.push(`- ${rule.path}: ${rule.description}`);
    }
  }
  if (sections.length === 0 && requestable.length === 0) return undefined;
  if (requestable.length > 0) {
    sections.push(
      `Read these rules with your file tools when they apply:\n${requestable.join("\n")}`,
    );
  }
  return `<user_rules>\nThe user's Cursor rules from the folders above this workspace, such as ~/.cursor/rules and ~/AGENTS.md. Follow them alongside the workspace's own rules. They replace any earlier <user_rules> block.\n\n${sections.join("\n\n")}\n</user_rules>`;
}
