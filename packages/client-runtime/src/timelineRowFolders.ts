import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";

type RunFolder = Pick<OrchestrationV2Run, "id" | "cwd" | "repositoryRoot">;
export type TimelineRunFolder = Pick<OrchestrationV2Run, "repositoryRoot"> & {
  readonly cwd: string;
};

export interface TimelineRowFolders {
  readonly byRunId: ReadonlyMap<RunId, TimelineRunFolder>;
  readonly byEntryId: ReadonlyMap<string, TimelineRunFolder>;
}

/** Live runs follow page folders, so they win; the string keeps rows stable across run events. */
export function runFoldersSignature(
  runs: ReadonlyArray<RunFolder>,
  runFolders: ReadonlyArray<RunFolder> = [],
): string {
  return JSON.stringify(
    [...runFolders, ...runs].flatMap(({ id, cwd, repositoryRoot }) =>
      cwd === undefined ? [] : [[id, { cwd, repositoryRoot }]],
    ),
  );
}

/**
 * A move receipt names the folder it left, which covers every earlier entry without a recorded
 * run. Entries stream in after the last receipt, so the string holds still while a reply streams.
 */
export function receiptFoldersSignature<Entry extends { readonly id: string }>(
  entries: ReadonlyArray<Entry>,
  previousFolderOf: (entry: Entry) => string | undefined,
): string {
  const covered: Array<[string, TimelineRunFolder]> = [];
  let folder: TimelineRunFolder | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (folder !== undefined) covered.push([entry.id, folder]);
    const previousFolder = previousFolderOf(entry);
    if (previousFolder !== undefined) folder = { cwd: previousFolder };
  }
  return JSON.stringify(covered);
}

export function timelineRowFolders(
  runsSignature: string,
  receiptsSignature: string,
): TimelineRowFolders {
  return {
    byRunId: new Map(JSON.parse(runsSignature) as Array<[RunId, TimelineRunFolder]>),
    byEntryId: new Map(JSON.parse(receiptsSignature) as Array<[string, TimelineRunFolder]>),
  };
}

/** The folder a row's links resolve in: its run's recorded folder, else the next receipt's. */
export function timelineRowFolder(
  folders: TimelineRowFolders,
  runId: RunId | null | undefined,
  entryId: string,
): TimelineRunFolder | undefined {
  return (runId == null ? undefined : folders.byRunId.get(runId)) ?? folders.byEntryId.get(entryId);
}
