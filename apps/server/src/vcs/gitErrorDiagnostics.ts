import type { GitFailureKind } from "@t3tools/contracts";

const MAX_SOURCE_CHARS = 8_192;
const MAX_DIAGNOSTIC_CHARS = 512;
const CONTROL_OR_ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- Git stderr is an untrusted process boundary
  /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PEM_BLOCK_PATTERN = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi;
const BEARER_CREDENTIAL_PATTERN = /\b(?:authorization\s*:\s*)?bearer\s+[^\s,;]+/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:token|password|passwd|secret|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi;
const ENV_ASSIGNMENT_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;]+/g;
const CLI_ASSIGNMENT_PATTERN = /--[A-Za-z0-9][A-Za-z0-9-]*=[^\s,;]+/g;
const URL_PATTERN = /\b(?:https?|ssh|git):\/\/[^\s]+/gi;
const URL_USERINFO_PATTERN = /\b[^\s:@/]+:[^\s@/]+@[^\s]+/g;
const PATH_PATTERN =
  /(?:[A-Za-z]:\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/)|\b[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-])[^\s,;)}\]]+/g;
const LONG_OPAQUE_PATTERN = /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/=-]{40,})\b/g;
const QUOTED_VALUE_PATTERN = /(['"`])[\s\S]*?\1/g;

export interface GitFailureDiagnostic {
  readonly failureKind: GitFailureKind;
  readonly safeDiagnostic: string;
}

const WORKTREE_FAILURE_MESSAGES = {
  worktree_branch_exists: "A local branch with the requested name already exists.",
  worktree_ref_in_use: "The requested branch is already checked out in another worktree.",
  worktree_path_exists: "The requested worktree path already exists.",
  worktree_registration_conflict:
    "Git has a stale or locked registration for the requested worktree.",
} as const satisfies Record<Exclude<GitFailureKind, "unknown">, string>;

export function sanitizeGitErrorDiagnostic(stderr: string): string {
  const sanitized = stderr
    .slice(0, MAX_SOURCE_CHARS)
    .replace(CONTROL_OR_ANSI_PATTERN, "")
    .replace(PEM_BLOCK_PATTERN, "[redacted-key-material]")
    .replace(BEARER_CREDENTIAL_PATTERN, "[redacted-credential]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "[redacted-credential]")
    .replace(ENV_ASSIGNMENT_PATTERN, "[redacted-environment-value]")
    .replace(CLI_ASSIGNMENT_PATTERN, "--[redacted-option]=[redacted]")
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(URL_USERINFO_PATTERN, "[redacted-url]")
    .replace(PATH_PATTERN, "[redacted-path]")
    .replace(LONG_OPAQUE_PATTERN, "[redacted-opaque-value]")
    .replace(QUOTED_VALUE_PATTERN, "[redacted-value]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CHARS)
    .trim();
  return sanitized.length > 0
    ? sanitized
    : "Git reported a non-zero exit status without a safe diagnostic.";
}

export function classifyWorktreeCreateFailure(stderr: string): GitFailureDiagnostic {
  const normalized = stderr.toLowerCase();
  let failureKind: Exclude<GitFailureKind, "unknown"> | undefined;

  if (normalized.includes("a branch named") && normalized.includes("already exists")) {
    failureKind = "worktree_branch_exists";
  } else if (
    normalized.includes("already used by worktree") ||
    normalized.includes("already checked out at")
  ) {
    failureKind = "worktree_ref_in_use";
  } else if (
    normalized.includes("missing but already registered worktree") ||
    normalized.includes("missing but locked worktree") ||
    (normalized.includes("worktree") && normalized.includes(" is locked"))
  ) {
    failureKind = "worktree_registration_conflict";
  } else if (normalized.includes("already exists")) {
    failureKind = "worktree_path_exists";
  }

  return failureKind === undefined
    ? {
        failureKind: "unknown",
        safeDiagnostic: sanitizeGitErrorDiagnostic(stderr),
      }
    : {
        failureKind,
        safeDiagnostic: WORKTREE_FAILURE_MESSAGES[failureKind],
      };
}
