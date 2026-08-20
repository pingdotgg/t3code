import type { EnvironmentId, ProgramAttemptSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProgramAttemptSummary, programAttemptAttention } from "./ThreadProgramAttemptPanel";

function snapshot(overrides: Partial<ProgramAttemptSnapshot> = {}): ProgramAttemptSnapshot {
  return {
    attemptId: "attempt:s6",
    programId: "agents-dlr",
    taskId: "agents-dlr.7",
    attemptKind: "task",
    candidateId: null,
    reviewId: null,
    reviewKind: null,
    title: "S6 certification",
    checkout: {
      repositoryRoot: "/repo",
      gitCommonDir: "/repo/.git",
      worktreePath: "/repo/worktrees/prepared",
      branch: "lavender/dirtyloops-parallel-runner",
      startingCommit: "1234567890abcdef",
    },
    projectId: "project:s6",
    threadId: "thread:s6",
    runId: "run:s6",
    state: "active",
    runStatus: "running",
    terminalResult: null,
    terminalAcknowledged: false,
    ...overrides,
  } as ProgramAttemptSnapshot;
}

describe("ThreadProgramAttemptPanel", () => {
  it("renders exact Task identity and read-only CLI guidance", () => {
    const markup = renderToStaticMarkup(
      <ProgramAttemptSummary
        attempt={snapshot()}
        environmentId={"environment:s6" as EnvironmentId}
        status="running"
      />,
    );
    expect(markup).toContain("S6 certification");
    expect(markup).toContain("agents-dlr.7");
    expect(markup).toContain("/repo/worktrees/prepared");
    expect(markup).toContain("dirtyloops inspect");
    expect(markup).toContain("dirtyloops stop agents-dlr.7");
    expect(markup).not.toContain("Retry");
    expect(markup).not.toContain("Admission");
  });

  it("identifies a focused candidate review and its live state", () => {
    const markup = renderToStaticMarkup(
      <ProgramAttemptSummary
        attempt={snapshot({
          attemptKind: "review",
          reviewKind: "focused",
          reviewId: "review:s6",
          candidateId: "candidate:0123456789",
          title: "agents-dlr.7 · focused candidate review",
        })}
        environmentId={"environment:s6" as EnvironmentId}
        status="completed"
      />,
    );
    expect(markup).toContain("Dirtyloops review");
    expect(markup).toContain("focused candidate review");
    expect(markup).toContain("Focused review · Completed");
    expect(markup).toContain("candidate:0123456789");
  });

  it("does not invent a retry decision", () => {
    expect(programAttemptAttention(snapshot(), "running")).toBe("None");
    expect(programAttemptAttention(snapshot(), "interrupted")).toContain("Dirtyloops will decide");
  });
});
