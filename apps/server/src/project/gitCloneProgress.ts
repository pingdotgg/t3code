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
  [/^Filtering content/, "checkout"],
];

const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$/;
const LFS_DOWNLOAD = /^Downloading LFS objects:\s+/;

/** Pass each bare-CR progress redraw as a separate line. */
export function parseGitCloneProgressLine(line: string): GitCloneProgressLine | null {
  const trimmed = line.trim();
  // A new stage literal would fail decoding on older clients, so `detail` names the transfer.
  if (LFS_DOWNLOAD.test(trimmed)) {
    return {
      stage: "checkout",
      percent: null,
      detail: trimmed.replace(LFS_DOWNLOAD, "Downloading LFS objects: "),
    };
  }
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
