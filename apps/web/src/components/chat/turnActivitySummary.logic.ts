import { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";
import { msg } from "gt-react";
import { type MessageResolver } from "../../i18n/messages";
import { workLogEntryIsToolLike, type WorkLogEntry } from "../../session-logic";

export interface TurnActivitySummary {
  readonly read: number;
  readonly edit: number;
  readonly command: number;
  readonly codeSearch: number;
  readonly webSearch: number;
  readonly other: number;
}

export interface TurnDiffStat {
  readonly additions: number;
  readonly deletions: number;
}

const EMPTY_SUMMARY: TurnActivitySummary = {
  read: 0,
  edit: 0,
  command: 0,
  codeSearch: 0,
  webSearch: 0,
  other: 0,
};

function entryItem(entry: WorkLogEntry) {
  return entry.structuredPayload ?? entry.projectedItem?.item;
}

/**
 * Counts a folded turn's tool calls by kind. Returns null when the client holds only part
 * of the turn's work (deferred on the wire), since partial counts would mislead.
 */
export function summarizeTurnActivity(
  entries: ReadonlyArray<WorkLogEntry>,
): TurnActivitySummary | null {
  const counts = { ...EMPTY_SUMMARY };
  const editedFiles = new Set<string>();
  let editsWithoutFiles = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.projectedItem?.item.deferredWork) return null;
    if (
      entry.itemType === "reasoning" ||
      entry.itemType === "todo_list" ||
      entry.itemType === "approval_request" ||
      entry.itemType === "user_input_request" ||
      entry.toolLifecycleStatus === "declined" ||
      !workLogEntryIsToolLike(entry)
    ) {
      continue;
    }
    total += 1;
    switch (toolGroupAction(entry)) {
      case "read":
        counts.read += 1;
        break;
      case "edit":
        if (entry.changedFiles && entry.changedFiles.length > 0) {
          for (const file of entry.changedFiles) editedFiles.add(file);
        } else {
          editsWithoutFiles += 1;
        }
        break;
      case "command":
        counts.command += 1;
        break;
      case "code-search":
        counts.codeSearch += 1;
        break;
      case "search":
        counts.webSearch += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  if (total === 0) return null;
  counts.edit = editedFiles.size + editsWithoutFiles;
  return counts;
}

/** Sums the line counts file changes report; null when none reported any. */
export function sumTurnItemDiffStat(entries: ReadonlyArray<WorkLogEntry>): TurnDiffStat | null {
  let additions = 0;
  let deletions = 0;
  let reported = false;
  for (const entry of entries) {
    const item = entryItem(entry);
    if (item?.type !== "file_change") continue;
    if (item.additions === undefined && item.deletions === undefined) continue;
    reported = true;
    additions += item.additions ?? 0;
    deletions += item.deletions ?? 0;
  }
  return reported && (additions > 0 || deletions > 0) ? { additions, deletions } : null;
}

/** One clause per kind, in a fixed order, reusing the tool-group summary strings. */
export function turnActivityClauses(
  summary: TurnActivitySummary,
  resolve: MessageResolver,
): string[] {
  const clauses: string[] = [];
  const { read, edit, command, codeSearch, webSearch, other } = summary;
  if (read > 0) {
    clauses.push(
      resolve(
        msg("{count, plural, one {Read {count} file} other {Read {count} files}}", {
          count: read,
        }),
      ),
    );
  }
  if (edit > 0) {
    clauses.push(
      resolve(
        msg("{count, plural, one {Changed {count} file} other {Changed {count} files}}", {
          count: edit,
        }),
      ),
    );
  }
  if (command > 0) {
    clauses.push(
      resolve(
        msg("{count, plural, one {Ran {count} command} other {Ran {count} commands}}", {
          count: command,
        }),
      ),
    );
  }
  if (codeSearch > 0) {
    clauses.push(
      resolve(
        msg(
          "{count, plural, one {Searched code {count} time} other {Searched code {count} times}}",
          { count: codeSearch },
        ),
      ),
    );
  }
  if (webSearch > 0) {
    clauses.push(
      resolve(
        msg(
          "{count, plural, one {Searched the web {count} time} other {Searched the web {count} times}}",
          { count: webSearch },
        ),
      ),
    );
  }
  if (other > 0) {
    clauses.push(
      resolve(
        msg("{count, plural, one {Used {count} tool} other {Used {count} tools}}", {
          count: other,
        }),
      ),
    );
  }
  return clauses;
}

export function turnActivityEqual(
  a: TurnActivitySummary | undefined,
  b: TurnActivitySummary | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.read === b.read &&
    a.edit === b.edit &&
    a.command === b.command &&
    a.codeSearch === b.codeSearch &&
    a.webSearch === b.webSearch &&
    a.other === b.other
  );
}

export function diffStatEqual(a: TurnDiffStat | undefined, b: TurnDiffStat | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.additions === b.additions && a.deletions === b.deletions;
}
