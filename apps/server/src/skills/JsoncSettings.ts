/**
 * JsoncSettings - change one value in an agent's JSON settings file and leave the rest as it was.
 *
 * Claude Code and OpenCode read their settings as JSONC (comments and trailing commas are fine),
 * and people keep both in these files, so `jsonc-parser` edits the text in place: comments, key
 * order and indentation survive. Two rules keep a bad write from ever happening:
 * - A file that doesn't parse (or that the caller's `accept` refuses) is left alone and reported
 *   `invalid`, since an edit would either overwrite what the user wrote or leave a file the agent
 *   still can't read.
 * - Nothing is written unless the edited text parses again and `accept` takes it.
 *
 * The write is atomic to the real file (a symlinked settings file stays a link) and keeps the
 * file's permissions, since these files can hold credentials.
 *
 * @module JsoncSettings
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

/** Keys of objects, and positions in arrays. */
export type JsonPath = ReadonlyArray<string | number>;

/**
 * Set `value` at `path`, or remove the key (or array item) when `value` is undefined. With
 * `insert`, `path` names an array and `value` is added at its end.
 */
export interface JsoncChange {
  readonly path: JsonPath;
  readonly value: unknown;
  readonly insert?: boolean;
}

/** `invalid`: the file is there but can't be edited safely. `failed`: the disk said no. */
export type JsoncEdit = "written" | "unchanged" | "invalid" | "failed";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What the agent would read, the root an object. Comments and trailing commas are allowed unless
 * `strict`, for an agent that reads its file with `JSON.parse`.
 */
export const parseJsonc = (text: string, strict = false) => {
  if (strict) {
    try {
      const value: unknown = JSON.parse(text);
      return { value, valid: isPlainObject(value) };
    } catch {
      return { value: undefined, valid: false };
    }
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return { value, valid: errors.length === 0 && isPlainObject(value) };
};

export const valueAt = (root: unknown, path: JsonPath): unknown => {
  let node = root;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(node)) return undefined;
      node = node[key];
    } else {
      if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
      node = node[key];
    }
  }
  return node;
};

const sameValue = (left: unknown, right: unknown) =>
  left === right || (left !== undefined && JSON.stringify(left) === JSON.stringify(right));

/** New text is indented and ended the way the file already is. */
const formattingOf = (text: string): FormattingOptions => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: Math.min(Math.max(indent?.length ?? 2, 1), 8), eol };
};

const changeText = (text: string, change: JsoncChange): string | undefined => {
  const options = { formattingOptions: formattingOf(text) };
  const edited = applyEdits(text, modify(text, [...change.path], change.value, options));
  if (parseJsonc(edited).valid) return edited;
  // When the only key of an object has a trailing comma, removing it leaves a stray comma behind.
  // Emptying the parent instead is always valid.
  if (
    change.value === undefined &&
    change.path.length > 1 &&
    typeof change.path.at(-1) === "string"
  ) {
    const emptied = applyEdits(text, modify(text, change.path.slice(0, -1), {}, options));
    if (parseJsonc(emptied).valid) return emptied;
  }
  return undefined;
};

/** Objects and lists a removal emptied go with it, so the file doesn't keep `"skillOverrides": {}`. */
const withoutEmptiedParents = (text: string, path: JsonPath) => {
  let result = text;
  for (let depth = path.length - 1; depth >= 1; depth -= 1) {
    const parent = valueAt(parseJsonc(result).value, path.slice(0, depth));
    const emptied = Array.isArray(parent)
      ? parent.length === 0
      : isPlainObject(parent) && Object.keys(parent).length === 0;
    if (!emptied) break;
    const removed = changeText(result, { path: path.slice(0, depth), value: undefined });
    if (removed === undefined) break;
    result = removed;
  }
  return result;
};

/**
 * Each step of the path through the file is what the next key expects: an object where a name
 * comes next, a list where a position comes next (or where a value is added to the end).
 */
const canReach = (root: unknown, change: JsoncChange) => {
  for (let depth = 1; depth <= change.path.length; depth += 1) {
    const here = valueAt(root, change.path.slice(0, depth));
    const last = depth === change.path.length;
    if (here === undefined || (last && !change.insert)) return true;
    const wantsList = last ? true : typeof change.path[depth] === "number";
    if (wantsList ? !Array.isArray(here) : !isPlainObject(here)) return false;
  }
  return true;
};

/**
 * The text with the changes applied, in order; undefined when one of them can't be made without
 * breaking the file. A path through something that isn't an object (`"permission": "allow"`) is
 * not edited.
 */
export const editJsoncText = (text: string, changes: ReadonlyArray<JsoncChange>) => {
  let result = text;
  for (const change of changes) {
    const current = parseJsonc(result).value;
    if (!canReach(current, change)) return undefined;
    // The editing library mangles single-line lists when it adds or removes one item, so a list
    // is replaced whole; only the file Pi reads as plain JSON has any, and it has no comments.
    const position = change.path.at(-1);
    const listPath = change.insert ? change.path : change.path.slice(0, -1);
    const list = valueAt(current, listPath);
    const effective: JsoncChange = change.insert
      ? { path: change.path, value: [...(Array.isArray(list) ? list : []), change.value] }
      : typeof position === "number" && change.value === undefined && Array.isArray(list)
        ? { path: listPath, value: list.filter((_, index) => index !== position) }
        : change;
    if (sameValue(valueAt(current, effective.path), effective.value)) continue;
    const edited = changeText(result, effective);
    if (edited === undefined) return undefined;
    result =
      change.value === undefined
        ? withoutEmptiedParents(edited, effective === change ? change.path : [...listPath, 0])
        : edited;
  }
  return result;
};

/** The file's text, or undefined when it isn't there or can't be read. */
export const readSettingsText = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  });

/**
 * Apply `changes` to the settings file, creating it when it isn't there. `accept` is the agent's
 * own idea of a valid file, checked on what is there and on what would be written; `strict` is for
 * an agent that reads plain JSON.
 */
export const editJsoncFile = Effect.fn("editJsoncFile")(function* (input: {
  readonly file: string;
  readonly changes: ReadonlyArray<JsoncChange>;
  readonly accept?: (value: Record<string, unknown>) => boolean;
  readonly strict?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(input.file).pipe(Effect.orElseSucceed(() => undefined));
  if (exists === undefined) return "failed" as const;
  const original = exists
    ? yield* fileSystem.readFileString(input.file).pipe(Effect.orElseSucceed(() => undefined))
    : "";
  if (original === undefined) return "failed" as const;

  // A file with nothing in it is an empty settings file.
  const text = original.trim() === "" ? "{}" : original;
  const accepted = (candidate: string) => {
    const { value, valid } = parseJsonc(candidate, input.strict);
    return valid && isPlainObject(value) && (input.accept?.(value) ?? true);
  };
  if (!accepted(text)) return "invalid" as const;

  const edited = editJsoncText(text, input.changes);
  if (edited === undefined || !accepted(edited)) return "invalid" as const;
  if (edited === text) return "unchanged" as const;

  const mode = exists
    ? yield* fileSystem.stat(input.file).pipe(
        Effect.map((info) => info.mode & 0o777),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  const contents = original.trim() === "" && !edited.endsWith("\n") ? `${edited}\n` : edited;
  return yield* writeFileStringAtomically({
    filePath: input.file,
    contents,
    ...(mode === undefined ? {} : { mode }),
  }).pipe(
    Effect.as("written" as const),
    Effect.catch(() => Effect.succeed("failed" as const)),
  );
});
