import { compareSemverVersions } from "./semver.ts";

export const JJ_MINIMUM_SUPPORTED_VERSION = "0.42.0";

export type JjVersionSupport =
  | {
      readonly status: "supported";
      readonly version: string;
    }
  | {
      readonly status: "unsupported";
      readonly version: string;
      readonly minimumVersion: string;
      readonly detail: string;
    }
  | {
      readonly status: "invalid";
      readonly detail: string;
    };

export type JjCommandFailureKind =
  | "not-repository"
  | "stale-workspace"
  | "unresolved-revision"
  | "bookmark-conflict"
  | "authentication"
  | "push-rejected"
  | "invalid-ref"
  | "command-failed";

export type JjRevisionConditionKind = "content-conflict";

export interface JjRevisionRecord {
  readonly commitId: string;
  readonly changeId: string;
  readonly description: string;
  readonly conflict: boolean;
  readonly empty: boolean;
  readonly parents: ReadonlyArray<string>;
  readonly workingCopies: ReadonlyArray<unknown>;
}

export interface JjChangedFileRecord {
  readonly path: string;
  readonly status: "modified" | "added" | "removed" | "copied" | "renamed";
  readonly conflict: boolean;
}

export interface JjBookmarkRecord {
  readonly name: string;
  readonly remote?: string;
  readonly target: ReadonlyArray<string>;
  readonly tracking_target?: ReadonlyArray<string>;
}

export interface JjWorkspaceRecord {
  readonly name: string;
  readonly target: {
    readonly commit_id: string;
    readonly parents: ReadonlyArray<string>;
    readonly change_id: string;
  };
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isJjRevisionRecord(value: unknown): value is JjRevisionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commitId === "string" &&
    typeof record.changeId === "string" &&
    typeof record.description === "string" &&
    typeof record.conflict === "boolean" &&
    typeof record.empty === "boolean" &&
    isStringArray(record.parents) &&
    Array.isArray(record.workingCopies)
  );
}

export function isJjChangedFileRecord(value: unknown): value is JjChangedFileRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.status === "string" &&
    ["modified", "added", "removed", "copied", "renamed"].includes(record.status) &&
    typeof record.conflict === "boolean"
  );
}

export function isJjBookmarkRecord(value: unknown): value is JjBookmarkRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    (record.remote === undefined || typeof record.remote === "string") &&
    isStringArray(record.target) &&
    (record.tracking_target === undefined || isStringArray(record.tracking_target))
  );
}

export function isJjWorkspaceRecord(value: unknown): value is JjWorkspaceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    typeof record.target !== "object" ||
    record.target === null
  ) {
    return false;
  }
  const target = record.target as Record<string, unknown>;
  return (
    typeof target.commit_id === "string" &&
    typeof target.change_id === "string" &&
    isStringArray(target.parents)
  );
}

const JJ_VERSION_PATTERN =
  /(?:^|\s)(?:jj\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/i;
const JJ_SOURCE_REVISION_SUFFIX_PATTERN = /-[0-9a-f]{40}$/i;

export function parseJjVersionOutput(output: string): string | null {
  return output.match(JJ_VERSION_PATTERN)?.[1] ?? null;
}

function getComparableJjVersion(version: string): string {
  return version.replace(JJ_SOURCE_REVISION_SUFFIX_PATTERN, "");
}

export function inspectJjVersion(output: string): JjVersionSupport {
  const version = parseJjVersionOutput(output);
  if (version === null) {
    return {
      status: "invalid",
      detail: `Could not parse the Jujutsu version from: ${JSON.stringify(output.trim())}`,
    };
  }

  if (compareSemverVersions(getComparableJjVersion(version), JJ_MINIMUM_SUPPORTED_VERSION) < 0) {
    return {
      status: "unsupported",
      version,
      minimumVersion: JJ_MINIMUM_SUPPORTED_VERSION,
      detail: `Jujutsu ${version} is unsupported. T3 Code requires jj ${JJ_MINIMUM_SUPPORTED_VERSION} or newer.`,
    };
  }

  return { status: "supported", version };
}

export const JJ_REVISION_JSON_TEMPLATE = [
  'concat("{\\"commitId\\":", json(commit_id),',
  '",\\"changeId\\":", json(change_id),',
  '",\\"description\\":", json(description),',
  '",\\"conflict\\":", json(conflict),',
  '",\\"empty\\":", json(empty),',
  '",\\"parents\\":", json(parents.map(|parent| parent.commit_id())),',
  '",\\"workingCopies\\":", json(working_copies), "}\\n")',
].join(" ");

export const JJ_CHANGED_FILE_JSON_TEMPLATE = [
  "diff.files().map(|entry|",
  'concat("{\\"path\\":", json(entry.path()),',
  '",\\"status\\":", json(entry.status()),',
  '",\\"conflict\\":", json(entry.target().conflict()), "}\\n"))',
  '.join("")',
].join(" ");

export const JJ_BOOKMARK_JSON_TEMPLATE = 'json(self) ++ "\\n"';
export const JJ_WORKSPACE_JSON_TEMPLATE = 'json(self) ++ "\\n"';
export const JJ_OPERATION_JSON_TEMPLATE = 'json(self) ++ "\\n"';

const JJ_MACHINE_GLOBAL_ARGS = ["--color=never", "--no-pager"] as const;

export const jjMachineCommand = {
  revision(revision = "@"): ReadonlyArray<string> {
    return [
      ...JJ_MACHINE_GLOBAL_ARGS,
      "log",
      "--no-graph",
      "--revisions",
      revision,
      "--template",
      JJ_REVISION_JSON_TEMPLATE,
    ];
  },
  changedFiles(revision = "@"): ReadonlyArray<string> {
    return [
      ...JJ_MACHINE_GLOBAL_ARGS,
      "log",
      "--no-graph",
      "--revisions",
      revision,
      "--template",
      JJ_CHANGED_FILE_JSON_TEMPLATE,
    ];
  },
  bookmarks(): ReadonlyArray<string> {
    return [
      ...JJ_MACHINE_GLOBAL_ARGS,
      "bookmark",
      "list",
      "--all-remotes",
      "--template",
      JJ_BOOKMARK_JSON_TEMPLATE,
    ];
  },
  workspaces(): ReadonlyArray<string> {
    return [
      ...JJ_MACHINE_GLOBAL_ARGS,
      "workspace",
      "list",
      "--template",
      JJ_WORKSPACE_JSON_TEMPLATE,
    ];
  },
  currentOperation(): ReadonlyArray<string> {
    return [
      ...JJ_MACHINE_GLOBAL_ARGS,
      "operation",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "--template",
      JJ_OPERATION_JSON_TEMPLATE,
    ];
  },
} as const;

export function parseJjJsonLines(output: string): ReadonlyArray<unknown> {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function quoteJjSymbol(value: string): string {
  if (value.includes("\0")) {
    throw new Error("jj symbols cannot contain NUL bytes");
  }
  return JSON.stringify(value);
}

export function quoteJjRootFileFileset(value: string): string {
  if (value.length === 0) {
    throw new Error("jj file paths cannot be empty");
  }
  if (value.includes("\0")) {
    throw new Error("jj file paths cannot contain NUL bytes");
  }
  if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(value)) {
    throw new Error("jj file paths must be workspace-relative");
  }
  if (value.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new Error("jj file paths cannot contain relative traversal segments");
  }
  return `root-file:${quoteJjSymbol(value)}`;
}

export function classifyJjRevisionCondition(
  revision: Pick<JjRevisionRecord, "conflict">,
): JjRevisionConditionKind | null {
  return revision.conflict ? "content-conflict" : null;
}

export function classifyJjCommandFailure(input: {
  readonly exitCode: number;
  readonly stderr: string;
}): JjCommandFailureKind | null {
  const normalized = input.stderr.toLowerCase();

  if (
    normalized.includes("failed to export some bookmarks") ||
    normalized.includes("not a valid ref name") ||
    normalized.includes("invalid bookmark name") ||
    normalized.includes("invalid ref name")
  ) {
    return "invalid-ref";
  }

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("permission denied (publickey)") ||
    normalized.includes("terminal prompts disabled") ||
    normalized.includes("could not read username") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    normalized.includes("refusing to push") ||
    normalized.includes("unexpectedly moved") ||
    normalized.includes("failed to push") ||
    normalized.includes("push was rejected") ||
    normalized.includes("non-fast-forward")
  ) {
    return "push-rejected";
  }

  if (
    normalized.includes("working copy is stale") ||
    normalized.includes("workspace is stale") ||
    normalized.includes("run `jj workspace update-stale`")
  ) {
    return "stale-workspace";
  }

  if (
    (normalized.includes("bookmark") && normalized.includes("conflict")) ||
    normalized.includes("conflicted bookmark") ||
    normalized.includes("resolved to more than one revision")
  ) {
    return "bookmark-conflict";
  }

  if (
    normalized.includes("there is no jj repo") ||
    normalized.includes("not a jj repository") ||
    normalized.includes("no repository found")
  ) {
    return "not-repository";
  }

  if (
    normalized.includes("revision doesn't exist") ||
    normalized.includes("revision does not exist") ||
    (normalized.includes("revision") && normalized.includes("doesn't exist")) ||
    normalized.includes("no such revision") ||
    normalized.includes("resolved to no revisions") ||
    (normalized.includes("revset") && normalized.includes("doesn't exist"))
  ) {
    return "unresolved-revision";
  }

  return input.exitCode === 0 ? null : "command-failed";
}
