import * as Schema from "effect/Schema";
import type { PullRequestCheck } from "@t3tools/contracts";

/**
 * The status-check part of `GET /repos/{owner}/{repo}/branches/{branch}`. Forgejo fills it from
 * the protection rule that governs the branch (exact names before globs, then the oldest rule),
 * and unlike `/branch_protections` it only needs read access to the repository.
 */
export const ForgejoBranchStatusChecks = Schema.Struct({
  enable_status_check: Schema.optional(Schema.Boolean),
  status_check_contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

// Forgejo compiles each context with gobwas/glob and no separator, so `*` and `**` both match any
// run of characters, `/` included, and `?` matches one character. Classes, alternation and escapes
// are not handled: a rule using them keeps every check gating rather than guessing.
const UNSUPPORTED_GLOB = /[[\]{}\\]/;
const contextPattern = (glob: string) =>
  new RegExp(
    `^${Array.from(glob, (char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^$()|]/g, "\\$&"),
    ).join("")}$`,
    "su",
  );

/**
 * Marks the checks the base branch requires. Without enabled status checks nothing changes.
 * An exact context with no status yet is added as a pending required check, as Forgejo itself
 * treats it, so the watch cannot pass before it reports. A glob that matches nothing names no
 * check to add and is left out.
 */
export function markRequiredForgejoChecks(
  checks: ReadonlyArray<PullRequestCheck>,
  branch: typeof ForgejoBranchStatusChecks.Type,
): ReadonlyArray<PullRequestCheck> {
  const contexts = branch.enable_status_check ? (branch.status_check_contexts ?? []) : [];
  if (contexts.length === 0 || contexts.some((context) => UNSUPPORTED_GLOB.test(context))) {
    return checks;
  }
  const patterns = contexts.map(contextPattern);
  const marked = checks.map((check) =>
    patterns.some((pattern) => pattern.test(check.name)) ? { ...check, required: true } : check,
  );
  const missing = [...new Set(contexts)].flatMap((name) =>
    !name.trim() || /[*?]/.test(name) || checks.some((check) => check.name === name)
      ? []
      : [{ name, status: "pending", description: null, url: null, required: true } as const],
  );
  return [...marked, ...missing];
}
