// @effect-diagnostics nodeBuiltinImport:off - the tool-call normalizer is synchronous
import * as NodeFS from "node:fs";

import { PositiveInt } from "@t3tools/contracts";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatchHunk } from "diff";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PRE_EDIT_FILE_LIMIT = 1024 * 1024;
// The live preview runs synchronously. One budget covers every chunk in a call: the generic
// ACP formatter's edit-distance limit, plus a size limit that skips diffing entirely.
const EDIT_DIFF_BUDGET = 1_000;
const EDIT_TEXT_BUDGET = 256 * 1024;

/** The edit is too large to preview cheaply; the turn's checkpoint diff still shows it. */
export const ANTIGRAVITY_EDIT_DIFF_OMITTED = Symbol("AntigravityEditDiffOmitted");
const SNIPPET_LABEL = " snippet, line unknown";

/** True when no chunk could be placed: the patch's first hunk is already a snippet. */
export function isAntigravitySnippetPatch(patch: string): boolean {
  return /^@@ .* @@.*$/m.exec(patch)?.[0].endsWith(SNIPPET_LABEL) === true;
}

const StartLine = Schema.optional(PositiveInt);
const ReplacementChunk = Schema.Struct({
  TargetContent: Schema.String,
  ReplacementContent: Schema.String,
  StartLine,
});
// replace_file_content sends one chunk at the top level; multi_replace_file_content sends a list.
const decodeEditInput = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ ReplacementChunks: Schema.NonEmptyArray(ReplacementChunk) }),
    ReplacementChunk,
  ]),
);
const decodeLocations = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ line: StartLine })),
);

/** Reads a small file for snippet matching; edits to large or unreadable files stay unlocated. */
export function readAntigravityPreEditFile(path: string): string | undefined {
  try {
    const stat = NodeFS.statSync(path);
    return stat.isFile() && stat.size <= PRE_EDIT_FILE_LIMIT
      ? NodeFS.readFileSync(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueStartLine(text: string | undefined, snippet: string): number | undefined {
  if (text === undefined || snippet === "") return undefined;
  const index = text.indexOf(snippet);
  if (index === -1 || text.indexOf(snippet, index + 1) !== -1) return undefined;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function snippetHunks(
  oldText: string,
  newText: string,
  maxEditLength: number,
): StructuredPatchHunk[] | undefined {
  // Snippets usually stop mid-file, so a missing final newline is not a change.
  const eol = oldText.endsWith("\n") || newText.endsWith("\n") ? "" : "\n";
  return structuredPatch("", "", oldText + eol, newText + eol, undefined, undefined, {
    maxEditLength,
  })?.hunks;
}

const changedLines = (hunks: ReadonlyArray<StructuredPatchHunk>) =>
  hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-")).length,
    0,
  );

/**
 * Antigravity reports replacements as bare old/new snippets. Builds a unified patch at the
 * announced start line, else at the snippet's unique match in the pre-edit file. Unplaced
 * chunks go in a second section whose hunks are labeled as snippets.
 */
export function antigravityEditPatch(input: {
  readonly path: string;
  readonly rawInput: unknown;
  readonly locations?: unknown;
  /** Pass only while the edit is pending, when the file still holds the old text. */
  readonly readPreEditFile?: ((path: string) => string | undefined) | undefined;
}): string | typeof ANTIGRAVITY_EDIT_DIFF_OMITTED | undefined {
  const edit = Option.getOrUndefined(decodeEditInput(input.rawInput));
  if (edit === undefined) return undefined;
  const announced = Option.getOrUndefined(decodeLocations(input.locations))?.[0]?.line;
  const chunks =
    "ReplacementChunks" in edit
      ? edit.ReplacementChunks
      : [{ ...edit, StartLine: edit.StartLine ?? announced }];
  let file: string | undefined;
  let fileRead = false;
  const textSize = chunks.reduce(
    (total, chunk) => total + chunk.TargetContent.length + chunk.ReplacementContent.length,
    0,
  );
  if (textSize > EDIT_TEXT_BUDGET) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
  let budget = EDIT_DIFF_BUDGET;
  const placed: Array<{ readonly start: number; readonly hunks: StructuredPatchHunk[] }> = [];
  const snippets: StructuredPatchHunk[] = [];
  for (const chunk of chunks) {
    const hunks = snippetHunks(chunk.TargetContent, chunk.ReplacementContent, budget);
    if (hunks === undefined) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    budget -= changedLines(hunks);
    if (budget < 0) return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    let start = chunk.StartLine;
    if (start === undefined && input.readPreEditFile !== undefined) {
      if (!fileRead) file = input.readPreEditFile(input.path);
      fileRead = true;
      start = uniqueStartLine(file, chunk.TargetContent);
    }
    if (start === undefined) snippets.push(...hunks);
    else placed.push({ start, hunks });
  }
  let shift = 0;
  const placedHunks = placed
    .toSorted((left, right) => left.start - right.start)
    .flatMap(({ start, hunks }) => {
      const shifted = hunks.map((hunk) => ({
        ...hunk,
        oldStart: hunk.oldStart + start - 1,
        newStart: hunk.newStart + start - 1 + shift,
      }));
      for (const hunk of hunks) shift += hunk.newLines - hunk.oldLines;
      return shifted;
    });
  const section = (hunks: StructuredPatchHunk[]) =>
    hunks.length === 0
      ? ""
      : formatPatch(
          {
            oldFileName: input.path,
            newFileName: input.path,
            oldHeader: undefined,
            newHeader: undefined,
            hunks,
          },
          FILE_HEADERS_ONLY,
        );
  const patch = [
    section(placedHunks),
    section(snippets).replace(/^@@ .* @@$/gm, `$&${SNIPPET_LABEL}`),
  ]
    .filter(Boolean)
    .join("\n");
  return patch || undefined;
}
