import * as Schema from "effect/Schema";
import type { PullRequestCheck } from "@t3tools/contracts";

// The branch endpoint reports the governing protection rule with repository read access.
export const ForgejoBranchStatusChecks = Schema.Struct({
  enable_status_check: Schema.optional(Schema.Boolean),
  status_check_contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

// Forgejo compiles each context with gobwas/glob and no separator, so `*` and `**` both match any
// run of characters, `/` included, and `?` matches one character. Classes, alternation and escapes
// are not handled.
const UNSUPPORTED_GLOB = /[[\]{}\\]/;
const contextPattern = (glob: string) =>
  new RegExp(
    `^${Array.from(glob, (char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^$()|]/g, "\\$&"),
    ).join("")}$`,
    "su",
  );

export function markRequiredForgejoChecks(
  checks: ReadonlyArray<PullRequestCheck>,
  branch: typeof ForgejoBranchStatusChecks.Type,
): ReadonlyArray<PullRequestCheck> {
  const contexts = branch.enable_status_check ? (branch.status_check_contexts ?? []) : [];
  if (contexts.length === 0) return checks;
  const unsupported = [...new Set(contexts.filter((context) => UNSUPPORTED_GLOB.test(context)))];
  if (unsupported.length > 0) {
    // Keep all observed checks gating, but never pass a policy we cannot evaluate.
    return [
      ...checks,
      ...unsupported.map((name) => ({
        name,
        status: "pending" as const,
        description: "Required check pattern cannot be evaluated.",
        url: null,
      })),
    ];
  }
  const patterns = [...new Set(contexts)].map((name) => ({ name, pattern: contextPattern(name) }));
  const marked = checks.map((check) =>
    patterns.some(({ pattern }) => pattern.test(check.name)) ? { ...check, required: true } : check,
  );
  // Forgejo keeps an unmatched required pattern pending, including wildcards.
  const missing = patterns.flatMap(({ name, pattern }) =>
    !name.trim() || checks.some((check) => pattern.test(check.name))
      ? []
      : [{ name, status: "pending", description: null, url: null, required: true } as const],
  );
  return [...marked, ...missing];
}
