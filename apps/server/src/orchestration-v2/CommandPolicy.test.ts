import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "@t3tools/provider-cursor/testing";
import * as CommandPolicy from "./CommandPolicy.ts";

const commandId = CommandId.make("command-policy-test");
const threadId = ThreadId.make("command-policy-thread");
const activeRunId = RunId.make("command-policy-active-run");
const activeAttemptId = RunAttemptId.make("command-policy-active-attempt");
const userMessageId = MessageId.make("command-policy-user-message");

const baseCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;

function capabilities(
  override: (current: OrchestrationV2ProviderCapabilities) => OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities {
  return override(baseCapabilities);
}

function dispatchProjection(
  sessionCapabilities?: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ThreadProjection {
  const providerThreadId = ProviderThreadId.make("command-policy-provider-thread");
  const providerSessionId = ProviderSessionId.make("command-policy-provider-session");
  return {
    runs:
      sessionCapabilities === undefined
        ? []
        : [
            {
              id: activeRunId,
              status: "running",
              providerThreadId,
              activeAttemptId,
              userMessageId,
            },
          ],
    messages: [{ id: userMessageId, text: "first", attachments: [] }],
    providerThreads:
      sessionCapabilities === undefined ? [] : [{ id: providerThreadId, providerSessionId }],
    providerSessions:
      sessionCapabilities === undefined
        ? []
        : [{ id: providerSessionId, capabilities: sessionCapabilities }],
    providerTurns:
      sessionCapabilities === undefined
        ? []
        : [{ runAttemptId: activeAttemptId, status: "running" }],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolveDispatch(
  projection: OrchestrationV2ThreadProjection,
  dispatchMode: Parameters<typeof CommandPolicy.resolveMessageDispatchIntent>[1]["dispatchMode"],
  deliveryIntent?: "auto" | "steer" | "restart",
  text = "next",
) {
  return CommandPolicy.resolveMessageDispatchIntent(projection, {
    dispatchMode,
    ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
    text,
    attachments: [],
  });
}

it("resolves automatic message delivery from authoritative provider capabilities", () => {
  assert.deepEqual(resolveDispatch(dispatchProjection(), { type: "start_immediately" }, "auto"), {
    type: "start_immediately",
  });
  assert.deepEqual(
    resolveDispatch(dispatchProjection(baseCapabilities), { type: "start_immediately" }, "auto"),
    { type: "steer_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    resolveDispatch(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: true,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    resolveDispatch(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: false,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

it.each(["preparing", "starting"] as const)(
  "queues an automatic message while the handoff run is %s",
  (status) => {
    const projection = dispatchProjection(baseCapabilities);
    assert.deepEqual(
      resolveDispatch(
        { ...projection, runs: projection.runs.map((run) => ({ ...run, status })) },
        { type: "start_immediately" },
        "auto",
      ),
      { type: "queue_after_active" },
    );
  },
);

it.each([
  ["has not started", []],
  ["is pending", [{ runAttemptId: activeAttemptId, status: "pending" }]],
  ["has completed", [{ runAttemptId: activeAttemptId, status: "completed" }]],
  [
    "belongs to a previous attempt",
    [{ runAttemptId: RunAttemptId.make("previous-attempt"), status: "running" }],
  ],
])("queues only automatic delivery when the active run's provider turn %s", (_, providerTurns) => {
  const projection = {
    ...dispatchProjection(baseCapabilities),
    providerTurns,
  } as unknown as OrchestrationV2ThreadProjection;
  assert.deepEqual(resolveDispatch(projection, { type: "start_immediately" }, "auto"), {
    type: "queue_after_active",
  });
  assert.deepEqual(resolveDispatch(projection, { type: "start_immediately" }, "steer"), {
    type: "steer_active",
    targetRunId: activeRunId,
  });
  assert.deepEqual(resolveDispatch(projection, { type: "start_immediately" }, "restart"), {
    type: "restart_active",
    targetRunId: activeRunId,
  });
});

// regression: #26695 an interrupt-restart steer cancels Copilot's background agents
it("queues a steer for a provider that cannot steer either way", () => {
  const projection = dispatchProjection(
    capabilities((current) => ({
      ...current,
      turns: {
        ...current.turns,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: false,
        supportsQueuedMessages: true,
      },
    })),
  );
  for (const deliveryIntent of ["auto", "steer"] as const) {
    assert.deepEqual(resolveDispatch(projection, { type: "start_immediately" }, deliveryIntent), {
      type: "queue_after_active",
    });
  }
  assert.deepEqual(
    resolveDispatch(projection, {
      type: "steer_active",
      targetRunId: activeRunId,
    }),
    { type: "queue_after_active" },
  );
  assert.deepEqual(resolveDispatch(projection, { type: "start_immediately" }, "restart"), {
    type: "restart_active",
    targetRunId: activeRunId,
  });
  assert.deepEqual(
    resolveDispatch(projection, {
      type: "steer_active",
      targetRunId: RunId.make("command-policy-missing-run"),
    }),
    { type: "steer_active", targetRunId: RunId.make("command-policy-missing-run") },
  );
});

// regression: #32606 a slash command steered into a running turn replaced the task
it.each([
  ["/context", { type: "queue_after_active" }],
  [" /context all\n", { type: "queue_after_active" }],
  ["/plugin:review-pr 12", { type: "queue_after_active" }],
  ["/home/me/x.ts fails", { type: "steer_active", targetRunId: activeRunId }],
  ["/ context", { type: "steer_active", targetRunId: activeRunId }],
  ["$skill /context", { type: "steer_active", targetRunId: activeRunId }],
] as const)("steers %j only when it is not a slash command", (text, expected) => {
  const projection = dispatchProjection(baseCapabilities);
  for (const deliveryIntent of ["auto", "steer"] as const) {
    assert.deepEqual(
      resolveDispatch(projection, { type: "start_immediately" }, deliveryIntent, text),
      expected,
    );
  }
});

it.each(["/compact", " /LOGOUT "])("queues a steer sent while %s runs", (text) => {
  const projection = dispatchProjection(baseCapabilities);
  const maintenance = {
    ...projection,
    messages: [{ id: userMessageId, text, attachments: [] }],
  } as unknown as OrchestrationV2ThreadProjection;
  for (const deliveryIntent of ["auto", "steer"] as const) {
    assert.deepEqual(resolveDispatch(maintenance, { type: "start_immediately" }, deliveryIntent), {
      type: "queue_after_active",
    });
  }
  assert.deepEqual(
    resolveDispatch(maintenance, {
      type: "steer_active",
      targetRunId: activeRunId,
    }),
    { type: "queue_after_active" },
  );
  assert.deepEqual(resolveDispatch(maintenance, { type: "start_immediately" }, "restart"), {
    type: "restart_active",
    targetRunId: activeRunId,
  });
});

const layer = it.layer(CommandPolicy.layer);

layer("CommandPolicyV2", (it) => {
  it.effect("falls back to portable context when Cursor cannot fork natively", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        capabilities: CursorProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
        sourceBusy: false,
      });

      assert.equal(result, "portable_context");
    }),
  );

  it.effect("forks a busy source through portable context", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;
      const decide = (sourceBusy: boolean) =>
        policy.decideForkExecution({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          sameProvider: true,
          hasStrongNativeSource: true,
          sourceRunStatus: "completed",
          fromSpecificTurn: true,
          sourceBusy,
        });

      assert.equal(yield* decide(false), "native_fork");
      assert.equal(yield* decide(true), "portable_context");
    }),
  );
});
