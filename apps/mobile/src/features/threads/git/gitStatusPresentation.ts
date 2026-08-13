interface GitStatusPresentation {
  readonly isRepo?: boolean;
  readonly hasWorkingTreeChanges?: boolean;
  readonly workingTree?: { readonly files: readonly { readonly path: string }[] };
  readonly aheadCount?: number;
  readonly behindCount?: number;
  readonly pr?: { readonly state?: string; readonly number?: number } | null;
  readonly remoteStatusKnown?: boolean;
}

export function resolveGitOverviewContentStatus(platform: string, summary: string): string | null {
  return platform === "ios" ? summary : null;
}

export function statusSummary(gitStatus: GitStatusPresentation | null): string {
  if (!gitStatus) {
    return "Loading branch status\u2026";
  }

  if (!gitStatus.isRepo) {
    return "Not a git repository";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    const fileCount = gitStatus.workingTree?.files.length ?? 0;
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  } else {
    parts.push("Clean");
  }
  if (gitStatus.remoteStatusKnown === false) {
    parts.push("Remote status unknown");
    return parts.join(" \u00b7 ");
  }
  if ((gitStatus.aheadCount ?? 0) > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if ((gitStatus.behindCount ?? 0) > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(`PR #${gitStatus.pr.number} open`);
  }

  return parts.join(" \u00b7 ");
}

export function compactStatusSummary(gitStatus: GitStatusPresentation | null): string {
  if (!gitStatus) {
    return "Checking status";
  }
  if (!gitStatus.isRepo) {
    return "Not a repo";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree?.files.length ?? 0} changed`);
  } else {
    parts.push("Clean");
  }
  if (gitStatus.remoteStatusKnown === false) {
    parts.push("Remote status unknown");
    return parts.join(" \u00b7 ");
  }
  if ((gitStatus.aheadCount ?? 0) > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if ((gitStatus.behindCount ?? 0) > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(`PR #${gitStatus.pr.number}`);
  }

  return parts.join(" \u00b7 ");
}
