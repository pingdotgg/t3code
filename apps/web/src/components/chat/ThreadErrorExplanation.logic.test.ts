import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canExplainThreadError,
  copyReportDetails,
  explanationLink,
  explanationStateFromFailure,
  explanationStateFromResult,
  REPORT_DETAILS_COPIED_NOTE,
  reportDetailsText,
  THREAD_ERROR_CHANGED_MESSAGE,
  threadErrorExplanationKey,
} from "./ThreadErrorExplanation.logic";

describe("canExplainThreadError", () => {
  it("offers the action for server provider failures", () => {
    expect(canExplainThreadError({ errorClass: "provider_error", hasTarget: true })).toBe(true);
    expect(canExplainThreadError({ errorClass: "unknown", hasTarget: true })).toBe(true);
    expect(canExplainThreadError({ errorClass: null, hasTarget: true })).toBe(true);
  });

  it("hides the action for usage limits", () => {
    expect(canExplainThreadError({ errorClass: "usage_limit", hasTarget: true })).toBe(false);
  });

  it("hides the action without a server thread to ask about", () => {
    expect(canExplainThreadError({ errorClass: "provider_error", hasTarget: false })).toBe(false);
  });
});

describe("explanationStateFromResult", () => {
  const result = {
    failureMessage: "spawn codex ENOENT",
    summary: "The binary is missing.",
    likelyFix: "Install it.",
    knownIssue: null,
    reportUrl: "https://github.com/pingdotgg/t3code/issues/new?template=bug_report.yml",
  };

  it("shows the explanation under the error it answers", () => {
    expect(explanationStateFromResult("spawn codex ENOENT", result)).toEqual({
      kind: "ready",
      failureMessage: "spawn codex ENOENT",
      summary: "The binary is missing.",
      likelyFix: "Install it.",
      link: {
        kind: "report",
        label: "Report this issue",
        url: "https://github.com/pingdotgg/t3code/issues/new?template=bug_report.yml",
      },
    });
  });

  it("fails when the explained error is not the one displayed", () => {
    expect(explanationStateFromResult("Provider crashed", result)).toEqual({
      kind: "failed",
      message: THREAD_ERROR_CHANGED_MESSAGE,
    });
  });
});

describe("explanationStateFromFailure", () => {
  it("reports the error message so the user can retry", () => {
    expect(explanationStateFromFailure(new Error("No model"))).toEqual({
      kind: "failed",
      message: "No model",
    });
  });

  it("falls back for failures without a message", () => {
    expect(explanationStateFromFailure("boom")).toEqual({
      kind: "failed",
      message: "The environment request failed.",
    });
    expect(explanationStateFromFailure(new Error(" "))).toEqual({
      kind: "failed",
      message: "The environment request failed.",
    });
  });
});

describe("threadErrorExplanationKey", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
    runId: RunId.make("run-a"),
  };

  it("starts fresh on another thread, environment or run with the same error text", () => {
    const key = threadErrorExplanationKey(target, "Provider crashed");
    expect(
      threadErrorExplanationKey(
        { ...target, threadId: ThreadId.make("thread-b") },
        "Provider crashed",
      ),
    ).not.toBe(key);
    expect(
      threadErrorExplanationKey(
        { ...target, environmentId: EnvironmentId.make("environment-b") },
        "Provider crashed",
      ),
    ).not.toBe(key);
    expect(
      threadErrorExplanationKey({ ...target, runId: RunId.make("run-b") }, "Provider crashed"),
    ).not.toBe(key);
    expect(threadErrorExplanationKey(target, "Provider crashed again")).not.toBe(key);
    expect(threadErrorExplanationKey(target, "Provider crashed")).toBe(key);
  });
});

describe("explanationLink", () => {
  const knownIssue = {
    number: 123,
    title: "Codex binary not found after update",
    url: "https://github.com/pingdotgg/t3code/issues/123",
  };
  const reportUrl = "https://github.com/pingdotgg/t3code/issues/new?template=bug_report.yml";

  it("links the matching issue instead of offering a report", () => {
    expect(explanationLink({ knownIssue, reportUrl })).toEqual({
      kind: "known-issue",
      label: "Known issue: #123 Codex binary not found after update",
      url: "https://github.com/pingdotgg/t3code/issues/123",
    });
  });

  it("offers the pre-filled report when no issue matches", () => {
    expect(explanationLink({ knownIssue: null, reportUrl })).toEqual({
      kind: "report",
      label: "Report this issue",
      url: reportUrl,
    });
  });

  it("offers nothing when the server could not build a link", () => {
    expect(explanationLink({ knownIssue: null, reportUrl: null })).toBeNull();
  });

  it("never opens an address that is not GitHub", () => {
    expect(
      explanationLink({
        knownIssue: { ...knownIssue, url: "https://evil.example/issues/123" },
        reportUrl: "javascript:alert(1)",
      }),
    ).toBeNull();
    expect(
      explanationLink({
        knownIssue: { ...knownIssue, url: "https://evil.example/issues/123" },
        reportUrl,
      }),
    ).toEqual({ kind: "report", label: "Report this issue", url: reportUrl });
  });
});

describe("report details", () => {
  it("holds the error and the whole explanation, which the link leaves out", () => {
    expect(
      reportDetailsText({
        failureMessage: "spawn codex ENOENT",
        summary: "The binary is missing.",
        likelyFix: "Install it.",
      }),
    ).toBe(
      [
        "Error message:",
        "spawn codex ENOENT",
        "",
        "What happened (explained by a text generation model, so it may be wrong):",
        "The binary is missing.",
        "",
        "Likely fix (same caveat):",
        "Install it.",
      ].join("\n"),
    );
    expect(REPORT_DETAILS_COPIED_NOTE).toBe(
      "Error details copied. Check them, then paste them into the form.",
    );
  });

  it("reports a successful copy", async () => {
    const copied: Array<string> = [];
    await expect(
      copyReportDetails("details", async (text) => void copied.push(text)),
    ).resolves.toBe(true);
    expect(copied).toEqual(["details"]);
  });

  it("reports a failed copy without throwing, so the link still opens", async () => {
    await expect(
      copyReportDetails("details", async () => {
        throw new Error("denied");
      }),
    ).resolves.toBe(false);
    await expect(
      copyReportDetails("details", () => {
        throw new Error("unavailable");
      }),
    ).resolves.toBe(false);
  });
});
