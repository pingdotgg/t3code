/**
 * fork: f4 — history paging.
 *
 * Three details are load-bearing and each has a test:
 * - `\x1f` / `\x1e` separators, so a `|` or a newline in a subject cannot
 *   corrupt field alignment.
 * - Cursor paging via `--skip=1 <hash>`, **never** `<hash>~1`: `~1` follows the
 *   first parent and silently drops the second-parent side of a merge.
 * - `hasMore` from asking for `limit + 1`, never guessed from
 *   `length % pageSize`.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyError, WorkingCopyLogEntry, WorkingCopyLogPage } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

export function parseLogEntries(stdout: string): ReadonlyArray<WorkingCopyLogEntry> {
  const entries: Array<WorkingCopyLogEntry> = [];
  for (const record of stdout.split(commands.LOG_RECORD_SEPARATOR)) {
    // git separates records with the format's trailing `\x1e` plus a newline.
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split(commands.LOG_FIELD_SEPARATOR);
    const hash = fields[0];
    const shortHash = fields[1];
    if (hash === undefined || shortHash === undefined || hash.length === 0) {
      continue;
    }
    entries.push({
      hash,
      shortHash,
      subject: fields[2] ?? "",
      authorName: fields[3] ?? "",
      authorEmail: fields[4] ?? "",
      authoredAt: fields[5] ?? "",
      parents: (fields[6] ?? "").split(" ").filter((parent) => parent.length > 0),
    });
  }
  return entries;
}

export const readLog = Effect.fn("workingCopy.readLog")(function* (
  git: WorkingCopyGit,
  input: {
    readonly limit?: number | undefined;
    readonly before?: string | undefined;
    readonly rev?: string | undefined;
    readonly grep?: string | undefined;
    readonly author?: string | undefined;
    readonly paths?: ReadonlyArray<string> | undefined;
  },
): Effect.fn.Return<WorkingCopyLogPage, WorkingCopyError> {
  const limit = commands.clampLogLimit(input.limit);
  // fork: f4 — `before`/`rev` are the module's other positional client strings.
  // The contract already pattern-checks them, but the argv layer's own rule is
  // that nothing positional reaches git unvalidated, so re-assert it here.
  const before =
    input.before === undefined
      ? undefined
      : yield* commands.requireHashIsh("workingCopy.log", input.before);
  const rev =
    input.rev === undefined
      ? undefined
      : yield* commands.requireHashIsh("workingCopy.log", input.rev);
  const output = yield* git.run({
    operation: "workingCopy.log",
    args: commands.logArgs({
      ...input,
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(rev !== undefined ? { rev } : {}),
    }),
  });

  // An empty repository, or a rev that no longer resolves after a rebase, is
  // an **empty page** — not an error. The panel must still render.
  if (output.exitCode !== 0) {
    return { entries: [], hasMore: false };
  }

  const entries = parseLogEntries(output.stdout);
  return {
    entries: entries.slice(0, limit),
    hasMore: entries.length > limit,
  };
});
