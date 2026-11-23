import type { AgentctlPullResult, AgentctlRepositoryStatus } from "@t3tools/contracts";

import type { SandboxTone } from "./sandboxActions";

/** `/home/me/code/app` as `~/code/app`, so rows lead with what tells folders apart. */
export function tildePath(path: string, homeDirectory: string): string {
  const home = homeDirectory.replace(/[\\/]+$/, "");
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  if (home === "" || !trimmed.startsWith(home)) return trimmed;
  const rest = trimmed.slice(home.length);
  if (rest === "") return "~";
  return /^[\\/]/.test(rest) ? `~${rest}` : trimmed;
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

export interface RepositoryBadge {
  readonly label: string;
  readonly tone: SandboxTone;
  readonly title?: string;
}

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

/** What a Pull would do, and what could stop it, for one checkout. */
export function repositoryBadges(status: AgentctlRepositoryStatus): RepositoryBadge[] {
  const badges: RepositoryBadge[] = [];
  if (status.branch === null) {
    badges.push({ label: "Detached", tone: "warning", title: "HEAD is not on a branch." });
  } else if (status.upstream === null) {
    badges.push({ label: "No upstream", tone: "muted", title: "The branch tracks nothing." });
  } else if (status.behind === null || status.ahead === null) {
    badges.push({
      label: "Upstream missing",
      tone: "warning",
      title: `Git cannot compare with ${status.upstream}.`,
    });
  }
  const behind = status.behind ?? 0;
  const ahead = status.ahead ?? 0;
  if (behind > 0) badges.push({ label: `${behind} behind`, tone: "info" });
  if (ahead > 0) {
    badges.push({
      label: `${ahead} ahead`,
      tone: behind > 0 ? "warning" : "muted",
      ...(behind > 0 ? { title: "Diverged, so Pull cannot fast-forward." } : {}),
    });
  }
  if (status.changes > 0) {
    badges.push({
      label: count(status.changes, "change"),
      tone: "warning",
      title: "Uncommitted changes can block a pull.",
    });
  }
  if (status.fetchError !== null) {
    badges.push({ label: "Fetch failed", tone: "error", title: status.fetchError });
  } else if (
    status.upstream !== null &&
    status.behind === 0 &&
    status.ahead === 0 &&
    status.changes === 0
  ) {
    badges.push({ label: "Up to date", tone: "success" });
  }
  return badges;
}

export interface PullToast {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
}

/** One toast for a pull of one or more folders, naming each repository that changed or failed. */
export function pullToast(result: AgentctlPullResult): PullToast {
  if (result.error !== null) {
    return { type: "error", title: "Could not pull repositories", description: result.error };
  }
  const failed = result.repositories.filter((repository) => repository.outcome === "failed");
  const updated = result.repositories.filter((repository) => repository.outcome === "updated");
  const lines = [
    ...failed.map((repository) => `${folderName(repository.repository)}: ${repository.error}`),
    ...updated.map(
      (repository) =>
        `${folderName(repository.repository)}: ${count(repository.commits, "new commit")}`,
    ),
  ];
  if (failed.length > 0) {
    return {
      type: "error",
      title:
        failed.length === result.repositories.length
          ? `Could not pull ${failed.length === 1 ? "the repository" : count(failed.length, "repository", "repositories")}`
          : `Could not pull ${failed.length} of ${result.repositories.length} repositories`,
      description: lines.join(" · "),
    };
  }
  if (updated.length === 0) {
    return {
      type: "success",
      title: "Already up to date",
      description: result.repositories
        .map((repository) => folderName(repository.repository))
        .join(", "),
    };
  }
  const commits = updated.reduce((total, repository) => total + repository.commits, 0);
  return {
    type: "success",
    title: `Pulled ${count(commits, "new commit")}`,
    description: lines.join(" · "),
  };
}
