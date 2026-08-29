import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorCommandPreviouslyRejectedError } from "../orchestration-v2/Orchestrator.ts";
import { ProviderSwitchServiceV2 } from "../orchestration-v2/ProviderSwitchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ConversationConfiguration from "./ConversationConfigurationMcpService.ts";

const projectId = "project:conversation-configuration" as never;
const parentThreadId = ThreadId.make("thread:conversation-configuration-parent");
const targetThreadId = ThreadId.make("thread:conversation-configuration-target");
const providerInstanceId = ProviderInstanceId.make("codex");

const provider = {
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-29T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoning",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function projection(input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: "approval-required" | "full-access";
  readonly interactionMode: "plan" | "default";
}): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: input.threadId,
      projectId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    },
    providerSessions: [],
    runs: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const scope = (capabilities: ReadonlyArray<"orchestration"> = ["orchestration"]) =>
  ({
    environmentId: EnvironmentId.make("environment:conversation-configuration"),
    threadId: parentThreadId,
    providerSessionId: "provider-session:conversation-configuration",
    providerInstanceId,
    capabilities: new Set(capabilities),
    issuedAt: 1,
  }) satisfies McpInvocationScope;

function testLayer(input: {
  readonly parent: OrchestrationV2ThreadProjection;
  readonly target: OrchestrationV2ThreadProjection;
  readonly dispatch: ThreadManagementService["Service"]["dispatch"];
  readonly getThreadProjection?: ThreadManagementService["Service"]["getThreadProjection"];
  readonly getReceipt?: CommandReceiptStoreV2["Service"]["getByCommandId"];
  readonly providers?: ReadonlyArray<ServerProvider>;
}) {
  return ConversationConfiguration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection:
            input.getThreadProjection ??
            ((threadId) =>
              Effect.succeed(threadId === parentThreadId ? input.parent : input.target)),
          getProjectThread: ({ threadId }) =>
            threadId === targetThreadId || threadId === parentThreadId
              ? Effect.succeed(threadId === parentThreadId ? input.parent : input.target)
              : Effect.die("unexpected thread"),
          dispatch: input.dispatch,
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(input.providers ?? [provider]),
        }),
        Layer.mock(CommandReceiptStoreV2)({
          getByCommandId: input.getReceipt ?? (() => Effect.succeed(Option.none())),
        }),
        Layer.mock(ProviderSwitchServiceV2)({
          plan: () =>
            Effect.succeed({
              instanceChanged: false,
              modelChanged: false,
              targetProviderThreadId: null,
              releaseProviderSessionIds: [],
              transition: { type: "switch_model_in_session" },
            }),
        }),
      ),
    ),
  );
}

describe("ConversationConfigurationMcpService", () => {
  it.effect("replays an accepted selection before provider availability planning", () =>
    Effect.gen(function* () {
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const target = projection({
        threadId: targetThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const layer = testLayer({
        parent,
        target,
        getReceipt: () =>
          Effect.succeed(
            Option.some({
              status: "accepted",
              threadId: targetThreadId,
              commandType: "provider.switch",
            } as never),
          ),
        dispatch: () =>
          Effect.succeed({
            sequence: 17,
            storedEvents: [
              { event: { id: "event:accepted-provider-switch", type: "thread.provider-switched" } },
            ] as never,
          }),
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* ConversationConfiguration.ConversationConfigurationMcpService;
        return yield* service.configure(scope(), {
          threadId: targetThreadId,
          providerInstanceId: ProviderInstanceId.make("provider-now-unavailable"),
          model: "unavailable-model",
          options: [],
          clientRequestId: "accepted-provider-switch",
        });
      }).pipe(Effect.provide(layer));

      assert.equal(result.changes[0]?.receipt?.commandType, "provider.switch");
      assert.equal(result.changes[0]?.receipt?.sequence, 17);
      assert.equal(result.selection.providerInstanceId, providerInstanceId);
    }),
  );

  it.effect("marks a failed refresh and does not infer replayed inputs as current", () =>
    Effect.gen(function* () {
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const target = projection({
        threadId: targetThreadId,
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      const layer = testLayer({
        parent,
        target,
        getThreadProjection: (threadId) =>
          threadId === parentThreadId
            ? Effect.succeed(parent)
            : Effect.fail(new Error("post-dispatch projection unavailable") as never),
        getReceipt: () => Effect.succeed(Option.none()),
        dispatch: () =>
          Effect.succeed({
            sequence: 23,
            storedEvents: [
              {
                event: {
                  id: "event:accepted-runtime-replay",
                  type: "thread.runtime-mode-updated",
                },
              },
            ] as never,
          }),
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* ConversationConfiguration.ConversationConfigurationMcpService;
        return yield* service.configure(scope(), {
          threadId: targetThreadId,
          runtimeMode: "full-access",
          clientRequestId: "accepted-runtime-before-another-writer",
        });
      }).pipe(Effect.provide(layer));

      assert.equal(result.observation, "pre_dispatch_fallback");
      assert.equal(result.runtimeMode, "approval-required");
      assert.equal(result.changes[0]?.receipt?.sequence, 23);
    }),
  );

  it.effect("validates every field before dispatch and enforces the caller ceiling", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      const target = projection({
        threadId: targetThreadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      const layer = testLayer({
        parent,
        target,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      });

      yield* Effect.gen(function* () {
        const service = yield* ConversationConfiguration.ConversationConfigurationMcpService;
        const invalidOptions = yield* service
          .configure(scope(), {
            threadId: targetThreadId,
            options: [{ id: "reasoning", value: "ultra" }],
            runtimeMode: "approval-required",
          })
          .pipe(Effect.flip);
        assert.equal(invalidOptions.code, "invalid_request");

        const escalation = yield* service
          .configure(scope(), { threadId: targetThreadId, interactionMode: "default" })
          .pipe(Effect.flip);
        assert.equal(escalation.code, "interaction_mode_escalation_denied");

        const unchanged = yield* service.configure(scope(), {
          threadId: targetThreadId,
          runtimeMode: "approval-required",
          clientRequestId: "fresh-unchanged-runtime-mode",
        });
        assert.equal(unchanged.outcome, "unchanged");
        assert.deepEqual(unchanged.changes, [
          {
            setting: "runtime_mode",
            behavior: "unchanged",
            requestedEffects: [],
            receipt: {
              commandId: unchanged.changes[0]!.receipt!.commandId,
              commandType: "thread.runtime-mode.set",
              sequence: 1,
              eventIds: [],
            },
          },
        ]);
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.runtime-mode.set"],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves accepted and rejected legs until a new request id is used", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
      const receipts = new Map<
        string,
        {
          readonly status: "accepted" | "rejected";
          readonly commandType: string;
          readonly result?: {
            readonly sequence: number;
            readonly storedEvents: ReadonlyArray<{ readonly event: { readonly id: string } }>;
          };
        }
      >();
      let runtimeFailureResolved = false;
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const target = projection({
        threadId: targetThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const layer = testLayer({
        parent,
        target,
        getReceipt: (commandId) => {
          const existing = receipts.get(commandId);
          return Effect.succeed(
            existing === undefined
              ? Option.none()
              : Option.some({
                  commandId,
                  threadId: targetThreadId,
                  commandType: existing.commandType,
                  status: existing.status,
                } as never),
          );
        },
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (commands) => [...commands, command.type]);
            const existing = receipts.get(command.commandId);
            if (existing?.status === "accepted") {
              return existing.result as never;
            }
            if (existing?.status === "rejected") {
              return yield* new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "runtime receipt failed",
              });
            }
            if (command.type === "thread.runtime-mode.set" && !runtimeFailureResolved) {
              receipts.set(command.commandId, { status: "rejected", commandType: command.type });
              return yield* Effect.fail(new Error("runtime receipt failed") as never);
            }
            const result = {
              sequence: receipts.size + 12,
              storedEvents: [{ event: { id: `event:${command.commandId}` } }],
            };
            receipts.set(command.commandId, {
              status: "accepted",
              commandType: command.type,
              result,
            });
            return result as never;
          }),
      });

      yield* Effect.gen(function* () {
        const service = yield* ConversationConfiguration.ConversationConfigurationMcpService;
        const result = yield* service.configure(scope(), {
          threadId: targetThreadId,
          options: [{ id: "reasoning", value: "high" }],
          runtimeMode: "approval-required",
          clientRequestId: "partial-configuration",
        });

        assert.equal(result.outcome, "partially_applied");
        assert.equal(result.changes[0]?.receipt?.sequence, 12);
        assert.deepEqual(result.errors, [
          { setting: "runtime_mode", message: "runtime receipt failed" },
        ]);
        assert.deepEqual(yield* Ref.get(dispatched), [
          "thread.model-selection.set",
          "thread.runtime-mode.set",
        ]);

        const sameKey = yield* service.configure(scope(), {
          threadId: targetThreadId,
          options: [{ id: "reasoning", value: "high" }],
          runtimeMode: "approval-required",
          clientRequestId: "partial-configuration",
        });
        assert.equal(sameKey.outcome, "partially_applied");
        assert.equal(sameKey.changes[0]?.receipt?.commandId, result.changes[0]?.receipt?.commandId);
        assert.match(sameKey.errors[0]?.message ?? "", /previously rejected/);
        assert.deepEqual(sameKey.retryGuidance, {
          sameClientRequestId: "replays_durable_decisions",
          afterRejectedLeg: "use_new_client_request_id",
        });

        runtimeFailureResolved = true;
        const stillRejected = yield* service.configure(scope(), {
          threadId: targetThreadId,
          options: [{ id: "reasoning", value: "high" }],
          runtimeMode: "approval-required",
          clientRequestId: "partial-configuration",
        });
        assert.equal(stillRejected.outcome, "partially_applied");
        assert.match(stillRejected.errors[0]?.message ?? "", /previously rejected/);

        const newAttempt = yield* service.configure(scope(), {
          threadId: targetThreadId,
          options: [{ id: "reasoning", value: "high" }],
          runtimeMode: "approval-required",
          clientRequestId: "partial-configuration-after-fix",
        });
        assert.equal(newAttempt.outcome, "applied");
        assert.deepEqual(newAttempt.errors, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("denies credentials without orchestration capability", () =>
    Effect.gen(function* () {
      const parent = projection({
        threadId: parentThreadId,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const layer = testLayer({
        parent,
        target: parent,
        dispatch: () => Effect.die("dispatch should not run"),
      });

      const error = yield* Effect.gen(function* () {
        const service = yield* ConversationConfiguration.ConversationConfigurationMcpService;
        return yield* service.read(scope([]), {}).pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.equal(error.code, "capability_denied");
    }),
  );
});
