import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  formatRestartRestoreCheckSummary,
  inspectRestartContinuation,
  restartRestoreCheckEntry,
  restartRestoreForecastMessage,
  restartRestoreOutcomeNotice,
  summarizeRestartRestoreCheck,
} from "./RestartRestoreCheck.ts";

const threadId = ThreadId.make("thread:restore-check");
const runId = RunId.make("run:restore-check");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restore-check");
const sessionId = ProviderSessionId.make("session:restore-check");
const attemptId = RunAttemptId.make("attempt:restore-check");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restore-check-project"),
      providerInstanceId: instanceId,
      title: "Honest restore",
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restore-check"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("RestartRestoreCheck", () => {
  it("forecasts a ready resume when native state is intact", () => {
    const projection = makeProjection();
    const run = projection.runs[0]!;
    assert.deepEqual(inspectRestartContinuation(projection, now), {
      status: "ready",
      run,
    });
    assert.deepEqual(restartRestoreCheckEntry({ projection, now, continueAfterRestart: true }), {
      threadId,
      status: "ready",
      sourceRunId: runId,
      title: "Honest restore",
    });
  });

  it("reports missing native state instead of a green recovery", () => {
    const projection = {
      ...makeProjection(),
      providerThreads: [{ ...makeProjection().providerThreads[0]!, nativeThreadRef: null }],
    } as OrchestrationV2ThreadProjection;
    const run = projection.runs[0]!;
    assert.deepEqual(inspectRestartContinuation(projection, now), {
      status: "not_ready",
      reason: "missing_native_state",
      run,
    });
    assert.deepEqual(restartRestoreCheckEntry({ projection, now, continueAfterRestart: true }), {
      threadId,
      status: "not_ready",
      reason: "missing_native_state",
      sourceRunId: runId,
      title: "Honest restore",
    });
  });

  it("keeps disabled continuation honest in the restore-check roster", () => {
    const projection = makeProjection();
    assert.deepEqual(restartRestoreCheckEntry({ projection, now, continueAfterRestart: false }), {
      threadId,
      status: "not_ready",
      reason: "continuation_disabled",
      sourceRunId: runId,
      title: "Honest restore",
    });
  });

  it("omits idle threads from the restore-check roster", () => {
    const projection = {
      ...makeProjection(),
      runs: [],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.isUndefined(restartRestoreCheckEntry({ projection, now, continueAfterRestart: true }));
  });

  it("summarizes mixed restore-check outcomes without claiming full recovery", () => {
    const summary = summarizeRestartRestoreCheck([
      {
        threadId: ThreadId.make("thread:a"),
        status: "ready",
        sourceRunId: RunId.make("run:a"),
        title: "Ready",
      },
      {
        threadId: ThreadId.make("thread:b"),
        status: "not_ready",
        reason: "missing_native_state",
        sourceRunId: RunId.make("run:b"),
        title: "Lost",
      },
      {
        threadId: ThreadId.make("thread:c"),
        status: "not_ready",
        reason: "continuation_disabled",
        title: "Opted out",
      },
    ]);
    assert.deepEqual(
      { total: summary.total, ready: summary.ready, notReady: summary.notReady },
      { total: 3, ready: 1, notReady: 2 },
    );
    assert.equal(
      formatRestartRestoreCheckSummary(summary),
      [
        "Restart restore-check: 1 would come back, 2 would not (3 total).",
        "  ready Ready (run:a)",
        "  not_ready Lost (run:b): missing_native_state",
        "  not_ready Opted out: continuation_disabled",
      ].join("\n"),
    );
  });

  it("keeps thread-visible forecast and outcome copy honest", () => {
    const base = "Cancelled because the server restarted before the provider work completed.";
    assert.include(
      restartRestoreForecastMessage(base, {
        threadId,
        status: "ready",
        sourceRunId: runId,
      }),
      "will attempt to resume",
    );
    assert.include(
      restartRestoreForecastMessage(base, {
        threadId,
        status: "not_ready",
        reason: "continuation_disabled",
      }),
      "Continue after restart is off",
    );
    assert.equal(restartRestoreOutcomeNotice("resumed").title, "Resumed after restart");
    assert.equal(restartRestoreOutcomeNotice("fresh").title, "Started a fresh provider session");
  });
});
