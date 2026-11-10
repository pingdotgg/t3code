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

// The tail is trimmed in code: optional groups of `\s*` and `.*?` backtrack cubically on long space runs.
const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(.*)$/;
const DONE_SUFFIX = ", done.";

/** Pass each bare-CR progress redraw as a separate line. */
export function parseGitCloneProgressLine(line: string): GitCloneProgressLine | null {
  const trimmed = line.trim();
  const stageEntry = STAGE_PREFIXES.find(([pattern]) => pattern.test(trimmed));
  if (!stageEntry) return null;
  const stage = stageEntry[1];
  const match = PERCENT.exec(trimmed);
  if (!match) return { stage, percent: null, detail: null };
  let tail = (match[4] ?? "").trimEnd();
  if (tail.endsWith(DONE_SUFFIX)) tail = tail.slice(0, -DONE_SUFFIX.length).trimEnd();
  if (tail.length > 0 && !tail.startsWith(",")) return { stage, percent: null, detail: null };
  const percent = Number(match[1]);
  const rawDetail = tail.slice(1).trim();
  const detail = rawDetail.length > 0 && rawDetail !== "done." ? rawDetail : null;
  return {
    stage,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    detail,
  };
}
