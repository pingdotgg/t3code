import type {
  ProjectIconColor,
  ProjectIconOverride,
  ProjectId,
  ProviderInstanceId,
  ThreadFolderRule,
} from "@t3tools/contracts";

export interface ThreadFolderRuleSubject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly hasPullRequest: boolean;
}

// Greedy `*` matching, at most pattern × value steps; a regex of many `.*` backtracks exponentially.
function matchesGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star !== -1) {
      p = star + 1;
      v = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

const matchesAny = (value: string | null, patterns: ReadonlyArray<string>) =>
  value !== null &&
  patterns.some((pattern) => matchesGlob(pattern.toLowerCase(), value.toLowerCase()));

// A keyword must start a word: "review" matches "reviews", never "preview".
const wordStart = (keyword: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");

const lastSegment = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path;

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

/**
 * The branch or worktree rule a folder's name points at, when all of its threads are on it:
 * "Fix status dropdown" holding threads on `t3code/fix-status-dropdown` collects that branch.
 */
export function inferThreadFolderRule(
  name: string,
  members: ReadonlyArray<Pick<ThreadFolderRuleSubject, "branch" | "worktreePath">>,
): ThreadFolderRule | null {
  const target = slug(name);
  const shared = (values: ReadonlyArray<string | null>, names: (value: string) => string[]) => {
    const [value] = values;
    return value && values.every((v) => v === value) && names(value).some((v) => slug(v) === target)
      ? value
      : null;
  };
  if (target === "" || members.length === 0) return null;
  const branch = shared(
    members.map((member) => member.branch),
    (value) => [value, lastSegment(value)],
  );
  if (branch) return { branches: [branch] };
  const worktree = shared(
    members.map((member) => member.worktreePath && lastSegment(member.worktreePath)),
    (value) => [value],
  );
  return worktree ? { worktrees: [worktree] } : null;
}

/** True when a thread's project, branch, worktree, or title names the folder: "Fleet" fits project "fleet". */
export function threadNamesFolder(
  name: string,
  thread: Pick<ThreadFolderRuleSubject, "title" | "branch" | "worktreePath"> & {
    readonly projectName: string | null;
  },
): boolean {
  const target = slug(name);
  if (target === "") return false;
  const names = [
    thread.projectName,
    thread.branch,
    thread.branch && lastSegment(thread.branch),
    thread.worktreePath && lastSegment(thread.worktreePath),
  ];
  return (
    names.some((value) => value && slug(value) === target) ||
    `-${slug(thread.title)}-`.includes(`-${target}-`)
  );
}

export const THREAD_FOLDER_ICONS: ReadonlyArray<
  readonly [words: ReadonlyArray<string>, name: string, color: ProjectIconColor]
> = [
  [["mobile", "ios", "android", "phone", "app"], "smartphone", "blue"],
  [["review", "audit"], "eye", "violet"],
  [["pr", "prs", "pull", "merge"], "git-pull-request", "violet"],
  [["bug", "bugs", "fix", "fixes", "hotfix", "issue", "issues"], "bug", "red"],
  [["test", "tests", "qa", "eval", "evals"], "flask-conical", "amber"],
  [["doc", "docs", "documentation", "guide"], "book-open", "sky"],
  [["design", "ui", "ux", "style"], "palette", "pink"],
  [["server", "backend", "api", "infra"], "server", "teal"],
  [["web", "frontend", "site", "browser"], "globe", "cyan"],
  [["desktop", "electron"], "monitor", "indigo"],
  [["release", "deploy", "ship", "launch"], "rocket", "orange"],
  [["research", "explore", "investigate", "spike"], "search", "lime"],
  [["idea", "ideas", "plan", "plans"], "lightbulb", "yellow"],
  [["security", "auth"], "shield-check", "emerald"],
  [["data", "database", "db", "migration", "migrations"], "database", "cyan"],
  [["perf", "performance", "speed"], "gauge", "orange"],
  [["agent", "agents", "ai", "bot", "fleet"], "bot", "green"],
  [["tool", "tools", "tooling", "chore", "chores", "setup"], "wrench", "gray"],
];

/** An icon and color that suit a folder's name, so a new folder looks right without customizing. */
export function threadFolderIcon(name: string): ProjectIconOverride {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const match = words
    .map((word) => THREAD_FOLDER_ICONS.find(([keys]) => keys.includes(word)))
    .find((entry) => entry !== undefined);
  return { kind: "lucide", name: match?.[1] ?? "folder", color: match?.[2] ?? "gray" };
}

/** True when a rule has at least one condition, so an empty rule never files every thread. */
export function threadFolderRuleHasConditions(rule: ThreadFolderRule): boolean {
  return Object.entries(rule).some(([key, value]) =>
    key === "smart" ? value === true : value !== undefined,
  );
}

export function threadMatchesFolderRule(
  rule: ThreadFolderRule,
  thread: ThreadFolderRuleSubject,
): boolean {
  if (!Object.entries(rule).some(([key, value]) => key !== "smart" && value !== undefined))
    return false;
  // Topic alone is the model's call; with branches or worktrees, those match directly.
  if (rule.smart && rule.branches === undefined && rule.worktrees === undefined) return false;
  if (rule.projectIds && !rule.projectIds.includes(thread.projectId)) return false;
  if (rule.providerInstanceIds && !rule.providerInstanceIds.includes(thread.providerInstanceId)) {
    return false;
  }
  if (rule.pullRequest !== undefined && rule.pullRequest !== thread.hasPullRequest) return false;
  if (
    (rule.branches || rule.worktrees) &&
    !(rule.branches && matchesAny(thread.branch, rule.branches)) &&
    !(
      rule.worktrees &&
      (matchesAny(thread.worktreePath, rule.worktrees) ||
        matchesAny(thread.worktreePath && lastSegment(thread.worktreePath), rule.worktrees))
    )
  ) {
    return false;
  }
  if (
    rule.titleKeywords &&
    !rule.titleKeywords.some((keyword) => wordStart(keyword).test(thread.title))
  ) {
    return false;
  }
  return true;
}

/** The first folder, in folder order, whose enabled rule matches the thread. */
export function pickThreadFolderForRule<
  F extends { readonly rule: ThreadFolderRule | null; readonly autoFile: boolean },
>(folders: ReadonlyArray<F>, thread: ThreadFolderRuleSubject): F | null {
  return (
    folders.find(
      (folder) =>
        folder.autoFile && folder.rule !== null && threadMatchesFolderRule(folder.rule, thread),
    ) ?? null
  );
}
