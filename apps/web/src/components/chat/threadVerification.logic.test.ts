import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  buildVerificationRequest,
  selectVerificationReport,
  verificationCommandStatus,
} from "./threadVerification.logic";

describe("verification evidence", () => {
  it.each([
    [{ status: "completed", exitCode: 0 }, "passed"],
    [{ status: "completed" }, "unconfirmed"],
    [{ status: "completed", exitCode: 2 }, "failed"],
    [{ status: "completed", exitCode: 0, outputIndicatesFailure: true }, "failed"],
    [{ status: "failed" }, "failed"],
    [{ status: "running", exitCode: 0 }, "running"],
    [{ status: "interrupted", exitCode: 0 }, "interrupted"],
  ] as const)("does not infer a pass from completion alone: %o", (item, expected) => {
    expect(verificationCommandStatus(item)).toBe(expected);
  });
  it("keeps evidence with the latest requested run and excludes unrelated later turns", () => {
    const prompt = buildVerificationRequest({ tests: true, browser: false, recording: true });
    const projection = {
      turnItems: [
        { type: "user_message", id: "old", runId: "old", ordinal: 0, text: prompt },
        {
          type: "command_execution",
          id: "old-check",
          runId: "old",
          ordinal: 1,
          input: "old",
          status: "completed",
          exitCode: 1,
        },
        { type: "user_message", id: "request", runId: "verify", ordinal: 2, text: prompt },
        {
          type: "command_execution",
          id: "check",
          runId: "verify",
          ordinal: 3,
          input: "npm test",
          status: "completed",
          exitCode: 0,
        },
        {
          type: "assistant_message",
          id: "report",
          runId: "verify",
          ordinal: 4,
          text: "Done",
          phase: "final_answer",
          streaming: false,
        },
        { type: "user_message", id: "other", runId: "other", ordinal: 5, text: "Other work" },
        {
          type: "command_execution",
          id: "other-check",
          runId: "other",
          ordinal: 6,
          input: "unrelated",
          status: "completed",
          exitCode: 0,
        },
      ],
      runs: [{ id: "verify", status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const report = selectVerificationReport(projection)!;
    expect(report.commands.map((command) => command.command)).toEqual(["npm test"]);
    expect(report.answer?.id).toBe("report");
    expect(report.runStatus).toBe("completed");
    expect(prompt).toContain("Do not record videos.");
    expect(prompt).toContain("Do not start browser checks");
    expect(buildVerificationRequest({ tests: true, browser: true, recording: true })).toContain(
      "Record the browser checks",
    );
  });
  it("does not attach runless historical commands to a queued request", () => {
    const projection = {
      turnItems: [
        {
          type: "user_message",
          id: "request",
          runId: null,
          ordinal: 0,
          text: buildVerificationRequest({ tests: true, browser: false, recording: false }),
        },
        {
          type: "command_execution",
          id: "noise",
          runId: null,
          ordinal: 1,
          input: "unrelated",
          status: "completed",
          exitCode: 0,
        },
      ],
      runs: [],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(selectVerificationReport(projection)?.commands).toEqual([]);
    expect(selectVerificationReport(null)).toBeNull();
  });
});
