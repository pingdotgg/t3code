import type { ProjectCloneStage } from "@t3tools/contracts";

export interface GitCloneProgressLine {
  readonly stage: ProjectCloneStage;
  readonly percent: number | null;
  readonly detail: string | null;
}

const STAGE_PREFIXES: ReadonlyArray<readonly [RegExp, ProjectCloneStage]> = [
  [/^remote: Enumerating objects/, "counting"],
  [/^remote: Counting objects/, "counting"],
  [/^remote: Compressing objects/, "counting"],
  [/^Receiving objects/, "receiving"],
  [/^Resolving deltas/, "resolving"],
  [/^Updating files/, "checkout"],
  [/^Checking out files/, "checkout"],
];

const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$/;

/**
 * Git redraws each counter with a bare `\r`, so callers hand over each redraw
 * as its own line.
 */
export function parseGitCloneProgressLine(line: string): GitCloneProgressLine | null {
  const trimmed = line.trim();
  const stageEntry = STAGE_PREFIXES.find(([pattern]) => pattern.test(trimmed));
  if (!stageEntry) return null;
  const stage = stageEntry[1];
  const match = PERCENT.exec(trimmed);
  if (!match) return { stage, percent: null, detail: null };
  const percent = Number(match[1]);
  const rawDetail = match[4]?.trim() ?? "";
  const detail = rawDetail.length > 0 && rawDetail !== "done." ? rawDetail : null;
  return {
    stage,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    detail,
  };
}
