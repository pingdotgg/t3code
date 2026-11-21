import type { CheckRun, CheckStatus } from "../domain/readiness";

const TIER = {
  failure: 0,
  cancelled: 0,
  "action-required": 0,
  pending: 1,
  success: 2,
  skipped: 2,
  neutral: 2,
} satisfies Record<CheckStatus, number>;

/** The list as the Checks tab shows it. A required check leads its group, and the placeholder for checks the host could not list goes last. */
export function sortChecks(checks: ReadonlyArray<CheckRun>): ReadonlyArray<CheckRun> {
  const rank = (check: CheckRun) =>
    check.placeholder ? 99 : TIER[check.status] * 2 + (check.required ? 0 : 1);
  return checks.toSorted((left, right) => rank(left) - rank(right));
}

type RollupKind = "failing" | "needs action" | "running" | "passing" | "skipped" | "neutral";

const PARTS: ReadonlyArray<readonly [label: RollupKind, statuses: ReadonlyArray<CheckStatus>]> = [
  ["failing", ["failure", "cancelled"]],
  ["needs action", ["action-required"]],
  ["running", ["pending"]],
  ["passing", ["success"]],
  ["skipped", ["skipped"]],
  ["neutral", ["neutral"]],
];

export interface RollupPart {
  readonly label: RollupKind | "some not listed";
  readonly count: number;
}

/** One entry per kind of check that is present, in the order the headline names them. */
export function rollupParts(checks: ReadonlyArray<CheckRun>): ReadonlyArray<RollupPart> {
  const real = checks.filter((check) => !check.placeholder);
  const parts = PARTS.flatMap(([label, statuses]): RollupPart[] => {
    const count = real.filter((check) => statuses.includes(check.status)).length;
    return count === 0 ? [] : [{ label, count }];
  });
  const unlisted = checks.length - real.length;
  return unlisted === 0 ? parts : [...parts, { label: "some not listed", count: unlisted }];
}

/** The group's headline, such as "1 failing, 2 running, 8 passing". */
export function summarizeChecks(checks: ReadonlyArray<CheckRun>): string {
  const parts = rollupParts(checks).map(({ label, count }) =>
    label === "some not listed" ? label : `${count} ${label}`,
  );
  return parts.length === 0 ? "No checks" : parts.join(", ");
}
