import { describe, expect, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

import {
  droidRuntimeModeForSessionMode,
  droidSessionMode,
  extractDroidSubagentUpdate,
} from "./droidAcp.ts";

describe("droidSessionMode", () => {
  it.each([
    ["approval-required", "normal"],
    ["auto-accept-edits", "auto-low"],
    ["auto", "auto-medium"],
    ["full-access", "auto-high"],
  ] as const)("maps %s to the %s autonomy level", (runtimeMode, modeId) => {
    expect(droidSessionMode(runtimeMode)).toBe(modeId);
  });

  it("round-trips every mode it picks", () => {
    for (const runtimeMode of [
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ] as const satisfies ReadonlyArray<RuntimeMode>) {
      expect(droidRuntimeModeForSessionMode(droidSessionMode(runtimeMode))).toBe(runtimeMode);
    }
  });
});

describe("droidRuntimeModeForSessionMode", () => {
  it("treats the read-only spec mode as asking before acting", () => {
    expect(droidRuntimeModeForSessionMode("spec")).toBe("approval-required");
  });

  it("ignores autonomy levels it does not know", () => {
    expect(droidRuntimeModeForSessionMode("yolo")).toBeUndefined();
  });
});

describe("extractDroidSubagentUpdate", () => {
  const task = (overrides: Partial<AcpToolCallState> = {}): AcpToolCallState => ({
    toolCallId: "call_1",
    kind: "other",
    title: "Worker: Count 1 to 8",
    status: "pending",
    data: {
      name: "Task",
      rawInput: {
        subagent_type: "worker",
        description: "Count 1 to 8",
        prompt: "Count from 1 to 8, one number per second.",
      },
    },
    ...overrides,
  });

  it("reads a launched worker as a running subagent", () => {
    expect(extractDroidSubagentUpdate(task())).toEqual({
      nativeTaskId: "call_1",
      childSessionId: null,
      prompt: "Count from 1 to 8, one number per second.",
      title: "Count 1 to 8",
      model: null,
      status: "pending",
      result: null,
    });
  });

  it("carries the worker's result once the tool settles", () => {
    expect(
      extractDroidSubagentUpdate(
        task({
          status: "completed",
          data: {
            name: "Task",
            rawInput: { prompt: "Count to 8", subagent_type: "worker" },
            rawOutput: { text: "1\n2\n3\n4\n5\n6\n7\n8" },
          },
        }),
      ),
    ).toMatchObject({ status: "completed", result: "1\n2\n3\n4\n5\n6\n7\n8" });
  });

  it("marks a failed worker as failed", () => {
    expect(extractDroidSubagentUpdate(task({ status: "failed" }))?.status).toBe("failed");
  });

  it("carries a settled worker whose update no longer includes its input", () => {
    expect(
      extractDroidSubagentUpdate(
        task({
          status: "completed",
          data: { name: "Task", rawOutput: { text: "1\n2\n3" } },
        }),
      ),
    ).toEqual({
      nativeTaskId: "call_1",
      childSessionId: null,
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      result: "1\n2\n3",
    });
  });

  it("falls back to the subagent type when the call has no description", () => {
    expect(
      extractDroidSubagentUpdate(
        task({ data: { name: "Task", rawInput: { prompt: "Do it", subagent_type: "worker" } } }),
      )?.title,
    ).toBe("worker");
  });

  it("ignores other tools and Task calls without a prompt until they settle", () => {
    expect(
      extractDroidSubagentUpdate(task({ data: { name: "Bash", rawInput: { prompt: "x" } } })),
    ).toBeUndefined();
    expect(extractDroidSubagentUpdate(task({ data: { name: "Task", rawInput: {} } }))).toBe(
      undefined,
    );
    expect(
      extractDroidSubagentUpdate(task({ status: "inProgress", data: { name: "Task" } })),
    ).toBeUndefined();
  });
});
