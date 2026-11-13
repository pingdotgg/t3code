import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { activeWorkTimerStartedAt, userWaitMs } from "./userWait.ts";

const at = (second: number) => DateTime.makeUnsafe(second * 1000);
const request = (from: number, to: number | null) => ({
  startedAt: at(from),
  completedAt: to === null ? null : at(to),
});

describe("userWaitMs", () => {
  it("counts overlapping and nested requests once", () => {
    expect(
      userWaitMs([request(30, 40), request(10, 20), request(15, 25), request(32, 35)], 0, 100_000),
    ).toBe(25_000);
  });

  it("clips requests to the run and runs an open one to its end", () => {
    expect(userWaitMs([request(-5, 5), request(90, null)], 0, 95_000)).toBe(10_000);
  });
});

describe("activeWorkTimerStartedAt", () => {
  const approval = (
    id: string,
    runId: RunId | null,
    from: number,
    to: number,
  ): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at(from),
    completedAt: at(to),
    updatedAt: at(to),
    type: "approval_request",
    requestId: RuntimeRequestId.make(id),
    requestKind: "command",
    prompt: "Allow touch?",
  });

  it("moves runless work's timer past only its own answered requests", () => {
    expect(
      activeWorkTimerStartedAt({
        runStartedAt: null,
        runlessStartedAt: DateTime.formatIso(at(100)),
        items: [
          approval("earlier-turn", null, 10, 20),
          approval("other-run", RunId.make("run"), 101, 200),
          approval("this-turn", null, 102, 162),
        ],
      }),
    ).toBe(DateTime.formatIso(at(160)));
  });

  it("moves a wake run's timer past the answered requests of the run it continues", () => {
    expect(
      activeWorkTimerStartedAt({
        runStartedAt: DateTime.formatIso(at(0)),
        runlessStartedAt: null,
        items: [
          approval("before-work", RunId.make("run-0"), -30, 10),
          approval("woken-run", RunId.make("run-a"), 2, 62),
        ],
      }),
    ).toBe(DateTime.formatIso(at(60)));
  });
});
