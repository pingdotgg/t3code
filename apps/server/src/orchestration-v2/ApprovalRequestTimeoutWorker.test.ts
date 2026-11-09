import { assert, describe, it } from "@effect/vitest";
import { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Cause from "effect/Cause";

import {
  APPROVAL_REQUEST_TIMEOUT_BATCH_SIZE,
  approvalRequestTimeoutCommand,
  APPROVAL_REQUEST_TIMEOUT_REASON,
  isAlreadyResolvedRuntimeRequestFailure,
} from "./ApprovalRequestTimeoutWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { layer as workerLayer } from "./ApprovalRequestTimeoutWorker.ts";

const threadId = ThreadId.make("thread:approval-timeout");
const createdAt = DateTime.makeUnsafe("2026-11-09T10:00:00.000Z");
const request = {
  id: RuntimeRequestId.make("request:approval-timeout"),
  kind: "permission" as const,
  status: "pending" as const,
  createdAt,
};

describe("approvalRequestTimeoutCommand", () => {
  it("does nothing when unset or before the deadline", () => {
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: null,
        nowMs: Date.parse("2026-11-09T10:01:00.000Z"),
      }),
    );
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: 120,
        nowMs: Date.parse("2026-11-09T10:01:59.999Z"),
      }),
    );
  });

  it("declines an overdue approval with a stable command id", () => {
    assert.deepEqual(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: 120,
        nowMs: Date.parse("2026-11-09T10:02:00.000Z"),
      }),
      {
        type: "runtime-request.respond",
        commandId: CommandId.make(
          "approval-timeout:thread:approval-timeout:request:approval-timeout",
        ),
        threadId,
        requestId: request.id,
        decision: "decline",
      },
    );
    assert.equal(APPROVAL_REQUEST_TIMEOUT_REASON, "Approval request timed out and was declined.");
  });

  it("leaves user-input requests for the user", () => {
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request: { ...request, kind: "user_input" },
        timeoutSeconds: 1,
        nowMs: Date.parse("2026-11-09T11:00:00.000Z"),
      }),
    );
  });

  it("leaves internal requests for their owning workflow", () => {
    for (const kind of ["auth_refresh", "dynamic_tool_call"] as const) {
      assert.isNull(
        approvalRequestTimeoutCommand({
          threadId,
          request: { ...request, kind },
          timeoutSeconds: 1,
          nowMs: Date.parse("2026-11-09T11:00:00.000Z"),
        }),
      );
    }
  });
});

describe("approval request timeout races", () => {
  it("treats a human answer that won first as a successful no-op", () => {
    const failure = new Orchestrator.OrchestratorDispatchError({
      commandId: CommandId.make("command:timeout"),
      commandType: "runtime-request.respond",
      cause: "Runtime request request:approval-timeout is resolved.",
    });
    assert.isTrue(isAlreadyResolvedRuntimeRequestFailure(Cause.fail(failure)));
  });

  it("keeps a timeout that won first successful", () => {
    assert.isFalse(isAlreadyResolvedRuntimeRequestFailure(Cause.die("unrelated failure")));
  });

  it("uses a bounded candidate page", () => {
    assert.equal(APPROVAL_REQUEST_TIMEOUT_BATCH_SIZE, 100);
  });
});

it.effect("leaves the timeout worker dormant when the setting is unset", () =>
  Effect.gen(function* () {
    const scans = yield* Ref.make(0);
    const providers = Layer.mergeAll(
      Scheduler.layer,
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getApprovalRequestTimeoutCandidates: () =>
          Ref.update(scans, (count) => count + 1).pipe(Effect.as([])),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ approvalRequestTimeout: null } as never),
        streamChanges: Stream.never,
      }),
    );
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        assert.equal(yield* Ref.get(scans), 0);
      }),
      workerLayer.pipe(Layer.provide(providers)),
    );
  }),
);

it.effect("asks the projection store for one bounded timeout page", () =>
  Effect.gen(function* () {
    const requestedLimit = yield* Ref.make<number | null>(null);
    const providers = Layer.mergeAll(
      Scheduler.layer,
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getApprovalRequestTimeoutCandidates: ({ limit }) =>
          Ref.set(requestedLimit, limit).pipe(Effect.as([])),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ approvalRequestTimeout: 60 } as never),
        streamChanges: Stream.never,
      }),
    );
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        assert.equal(yield* Ref.get(requestedLimit), APPROVAL_REQUEST_TIMEOUT_BATCH_SIZE);
      }),
      workerLayer.pipe(Layer.provide(providers)),
    );
  }),
);
