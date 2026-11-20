import { describe, expect, it } from "vite-plus/test";

import {
  type CheckRun,
  type ConditionKey,
  evaluateReadiness,
  isStuck,
  missingKeys,
  mergeTicketKey,
  type PrLive,
  type ReadinessInput,
  rollupChecks,
} from "./readiness";
import type { Ticket } from "./ticket";

const REVIEW_ROLES: ReadonlySet<string> = new Set(["reviewer", "security-reviewer"]);
const NOW = Date.parse("2026-11-20T12:00:00Z");
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

const check = (name: string, status: CheckRun["status"], runningSince: number | null = null) => ({
  name,
  status,
  placeholder: false,
  runningSince,
});

const live = (checks: ReadonlyArray<CheckRun>, headSha: string | null = "abc1234"): PrLive => ({
  state: "open",
  checksState: rollupChecks(checks),
  mergeability: "mergeable",
  headSha,
  checks,
});

const green = live([check("lint", "success"), check("test", "success")]);

const ticketOf = (fields: Partial<Ticket> & { key: string }): Ticket => ({
  title: "A ticket",
  stage: "pr",
  ...fields,
});

const clean = [
  { role: "reviewer", p0: 0, p1: 0, p2: 1, p3: 0 },
  { role: "security-reviewer", p0: 0, p1: 0, p2: 0, p3: 0 },
];
const evidence = ["artifacts/T-1/readme-check.txt", "artifacts/T-1/smoke.png"];

const missingOf = (
  fields: Partial<ReadinessInput> & { ticket: Ticket },
): ReadonlyArray<ConditionKey> =>
  missingKeys(
    evaluateReadiness({
      tickets: [fields.ticket],
      evidence,
      live: green,
      mergeOrderNote: null,
      reviewRoles: REVIEW_ROLES,
      now: NOW,
      ...fields,
    }),
  );

describe("merge readiness", () => {
  it("Given a ticket with every condition true, when readiness is computed, then nothing is missing", () => {
    const ticket = ticketOf({
      key: "T-1",
      pr: 12,
      headSha: "abc1234",
      verdicts: clean,
      fixRounds: 1,
      threads: [{ threadId: "th-1", role: "reviewer", round: 1 }],
    });
    expect(missingOf({ ticket })).toEqual([]);
  });

  it("Given a verdict with an unresolved P1, when readiness is computed, then only the reviews condition is missing", () => {
    const ticket = ticketOf({
      key: "T-1",
      pr: 12,
      verdicts: [{ role: "reviewer", p1: 1 }, clean[1]!],
    });
    const conditions = evaluateReadiness({
      ticket,
      tickets: [ticket],
      evidence,
      live: green,
      mergeOrderNote: null,
      reviewRoles: REVIEW_ROLES,
      now: NOW,
    });
    expect(missingKeys(conditions)).toEqual(["reviews_fixed"]);
    expect(conditions[1]?.missing).toBe("Unresolved P0 or P1 from reviewer");
  });

  it("Given a role's clean re-review after its P1, when readiness is computed, then the reviews condition holds", () => {
    const ticket = ticketOf({
      key: "T-1",
      pr: 12,
      verdicts: [{ role: "reviewer", p1: 1 }, clean[1]!, { role: "reviewer", p1: 0 }],
    });
    expect(missingOf({ ticket })).toEqual([]);
  });

  it("Given a child of a parent still in a PR with a failing check and no README check, when readiness is computed, then CI, the README check, and the parent are missing", () => {
    const parent = ticketOf({ key: "T-0", stage: "pr" });
    const ticket = ticketOf({ key: "T-1", pr: 12, dependsOn: ["T-0"], verdicts: clean });
    expect(
      missingOf({
        ticket,
        tickets: [parent, ticket],
        evidence: ["artifacts/T-1/smoke.png"],
        live: live([check("lint", "success"), check("test", "failure")]),
      }),
    ).toEqual(["ci_green", "readmes_pass", "parent_ready"]);
  });

  it("Given a ticket with no pull request, one review, an unreviewed fix round, no evidence, and a ready parent with no merge-order note, when readiness is computed, then all six are missing", () => {
    const parent = ticketOf({ key: "T-0", stage: "awaiting_approval" });
    const ticket = ticketOf({
      key: "T-1",
      dependsOn: ["T-0"],
      verdicts: [clean[0]!],
      fixRounds: 2,
      threads: [{ threadId: "th-1", role: "reviewer", round: 1 }],
    });
    expect(missingOf({ ticket, tickets: [parent, ticket], evidence: [], live: null })).toEqual([
      "ci_green",
      "reviews_fixed",
      "delta_rereviewed",
      "readmes_pass",
      "parent_ready",
      "smoke_named",
    ]);
  });

  it("Given a ready parent and a merge-order note, when readiness is computed, then the parent condition holds", () => {
    const parent = ticketOf({ key: "T-0", stage: "awaiting_approval" });
    const ticket = ticketOf({ key: "T-1", pr: 12, dependsOn: ["T-0"], verdicts: clean });
    expect(
      missingOf({ ticket, tickets: [parent, ticket], mergeOrderNote: "Merge T-0 first" }),
    ).toEqual([]);
  });

  it("Given checks that ran on another commit than the ticket's head, when readiness is computed, then CI is missing", () => {
    const ticket = ticketOf({ key: "T-1", pr: 12, headSha: "def5678", verdicts: clean });
    expect(missingOf({ ticket })).toEqual(["ci_green"]);
  });
});

describe("stuck checks", () => {
  it("Given a check running 21 minutes, when it is tested, then it is stuck", () => {
    expect(isStuck(check("test", "pending", minutesAgo(21)), NOW)).toBe(true);
  });

  it("Given a check running 19 minutes, when it is tested, then it is not stuck", () => {
    expect(isStuck(check("test", "pending", minutesAgo(19)), NOW)).toBe(false);
  });

  it("Given a finished check that began 30 minutes ago, when it is tested, then it is not stuck", () => {
    expect(isStuck(check("test", "success", minutesAgo(30)), NOW)).toBe(false);
  });

  it("Given a check running 21 minutes, when readiness is computed, then CI names it as stuck", () => {
    const ticket = ticketOf({ key: "T-1", pr: 12, verdicts: clean });
    const conditions = evaluateReadiness({
      ticket,
      tickets: [ticket],
      evidence,
      live: live([check("test", "pending", minutesAgo(21))]),
      mergeOrderNote: null,
      reviewRoles: REVIEW_ROLES,
      now: NOW,
    });
    expect(conditions[0]?.missing).toBe("test stuck");
  });
});

describe("the ticket a merge approval is about", () => {
  const keys = ["T-1", "T-10", "XEO-3330"];

  it("Given a title naming T-10, when it is matched, then T-10 wins over T-1", () => {
    expect(mergeTicketKey({ id: "m1", title: "[T-10] Ready to merge" }, keys)).toBe("T-10");
  });

  it("Given an item that names its ticket, when it is matched, then the named ticket wins over the title", () => {
    expect(mergeTicketKey({ id: "m1", title: "[T-10] Ready", ticket: "T-1" }, keys)).toBe("T-1");
  });

  it("Given a title that names no ticket, when it is matched, then nothing is found", () => {
    expect(mergeTicketKey({ id: "m1", title: "Ship it" }, keys)).toBeNull();
  });
});
