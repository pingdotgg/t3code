import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { decodeGitHubCheckRollupJson, summarizeGitHubCheckRollup } from "./gitHubPullRequests.ts";

const checkRun = (fields: { status?: string; conclusion?: string | null }) => ({
  typename: "CheckRun",
  status: fields.status ?? "COMPLETED",
  conclusion: fields.conclusion ?? null,
  state: null,
});

const statusContext = (state: string | null) => ({
  typename: "StatusContext",
  status: null,
  conclusion: null,
  state,
});

describe("summarizeGitHubCheckRollup", () => {
  it("reports success only when every conclusive check passed", () => {
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SUCCESS" }),
        statusContext("SUCCESS"),
        checkRun({ conclusion: "SUCCESS" }),
      ]),
    ).toEqual({ state: "success", total: 3, passed: 3, failed: 0, pending: 0 });
  });

  it("lets a single failure outrank passing and in-flight checks", () => {
    // The failure is the actionable signal: a red dot must win over amber even
    // while the rest of the suite is still running.
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SUCCESS" }),
        checkRun({ status: "IN_PROGRESS" }),
        statusContext("FAILURE"),
      ]),
    ).toEqual({ state: "failure", total: 3, passed: 1, failed: 1, pending: 1 });
  });

  it("treats an incomplete CheckRun as pending regardless of conclusion", () => {
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ status: "QUEUED" }),
        checkRun({ conclusion: "SUCCESS" }),
      ]),
    ).toEqual({ state: "pending", total: 2, passed: 1, failed: 0, pending: 1 });
  });

  it("counts skipped and neutral checks toward the total but not the verdict", () => {
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SKIPPED" }),
        checkRun({ conclusion: "NEUTRAL" }),
        checkRun({ conclusion: "SUCCESS" }),
      ]),
    ).toEqual({ state: "success", total: 3, passed: 1, failed: 0, pending: 0 });
  });

  it("reports no signal when nothing passed, failed, or is pending", () => {
    // An all-skipped suite is not an endorsement: green here would claim the
    // work is verified when no check actually ran.
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SKIPPED" }),
        checkRun({ conclusion: "NEUTRAL" }),
      ]),
    ).toBeNull();
  });

  it("does not strand the indicator on pending for a stateless status context", () => {
    // A StatusContext with no state never resolves, so treating it as pending
    // would leave an amber dot up forever.
    expect(summarizeGitHubCheckRollup([statusContext(null)])).toBeNull();
  });

  it("keeps a real verdict when a stateless entry sits alongside it", () => {
    expect(
      summarizeGitHubCheckRollup([statusContext(null), checkRun({ conclusion: "SUCCESS" })]),
    ).toEqual({ state: "success", total: 2, passed: 1, failed: 0, pending: 0 });
  });

  it("maps every terminal failure conclusion to failed", () => {
    for (const conclusion of [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "STARTUP_FAILURE",
      "ACTION_REQUIRED",
      "STALE",
    ]) {
      expect(summarizeGitHubCheckRollup([checkRun({ conclusion })])?.state).toBe("failure");
    }
  });

  it("does not let a stale check hide behind passing ones", () => {
    // GitHub marks stuck runs stale. That is not a success and can block merge,
    // so a suite carrying one must not render green.
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SUCCESS" }),
        checkRun({ conclusion: "STALE" }),
      ]),
    ).toEqual({ state: "failure", total: 2, passed: 1, failed: 1, pending: 0 });
  });

  it("does not turn an unrecognized conclusion into a failure or a pass", () => {
    // A conclusion GitHub adds later must never light the indicator red on its
    // own, and must not read green either: it lands in the neutral bucket, so
    // on its own it produces no signal at all.
    expect(summarizeGitHubCheckRollup([checkRun({ conclusion: "SOMETHING_NEW" })])).toBeNull();
    expect(
      summarizeGitHubCheckRollup([
        checkRun({ conclusion: "SOMETHING_NEW" }),
        checkRun({ conclusion: "FAILURE" }),
      ])?.state,
    ).toBe("failure");
  });

  it("returns null when the rollup is empty so no indicator renders", () => {
    expect(summarizeGitHubCheckRollup([])).toBeNull();
  });
});

describe("decodeGitHubCheckRollupJson", () => {
  it("decodes the projected rollup payload", () => {
    const decoded = decodeGitHubCheckRollupJson(
      JSON.stringify([
        { typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", state: null },
        { typename: "StatusContext", status: null, conclusion: null, state: "FAILURE" },
      ]),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    expect(Result.isSuccess(decoded) ? decoded.success : null).toEqual({
      state: "failure",
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
    });
  });

  it("skips entries it cannot decode rather than failing the batch", () => {
    const decoded = decodeGitHubCheckRollupJson(
      JSON.stringify([42, { typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]),
    );

    expect(Result.isSuccess(decoded) ? decoded.success : null).toEqual({
      state: "failure",
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
    });
  });

  it("fails when the payload is not an array", () => {
    expect(Result.isSuccess(decodeGitHubCheckRollupJson("{}"))).toBe(false);
  });
});
