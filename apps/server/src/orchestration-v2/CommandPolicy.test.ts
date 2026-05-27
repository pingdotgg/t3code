import { assert, it } from "@effect/vitest";
import { CommandId, type OrchestrationV2ProviderCapabilities, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  CommandPolicyCapabilityUnsupportedError,
  CommandPolicyV2,
  layer as commandPolicyLayer,
} from "./CommandPolicy.ts";

const commandId = CommandId.make("command-policy-test");
const threadId = ThreadId.make("command-policy-thread");

const baseCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;

function capabilities(
  override: (current: OrchestrationV2ProviderCapabilities) => OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities {
  return override(baseCapabilities);
}

const layer = it.layer(commandPolicyLayer);

layer("CommandPolicyV2", (it) => {
  it.effect("prefers direct active steering when the provider supports it", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        provider: "codex",
        capabilities: baseCapabilities,
      });

      assert.equal(result, "active_steering");
    }),
  );

  it.effect("uses interrupt-and-restart steering when direct steering is unavailable", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        provider: "codex",
        capabilities: capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsInterrupt: true,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      });

      assert.equal(result, "interrupt_restart");
    }),
  );

  it.effect("returns typed capability errors for unsupported active steering", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .decideSteeringExecution({
          commandId,
          threadId,
          provider: "codex",
          capabilities: capabilities((current) => ({
            ...current,
            turns: {
              ...current.turns,
              supportsActiveSteering: false,
              supportsInterrupt: false,
              supportsSteeringByInterruptRestart: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "active_steering");
    }),
  );

  it.effect("guards native fork behind fork and identity capabilities", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .ensureNativeFork({
          commandId,
          threadId,
          provider: "codex",
          fromSpecificTurn: true,
          capabilities: capabilities((current) => ({
            ...current,
            identity: {
              ...current.identity,
              nativeThreadIds: "weak",
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "native_fork");
    }),
  );

  it.effect("guards rollback behind provider rollback snapshot support", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .ensureRollback({
          commandId,
          threadId,
          provider: "codex",
          capabilities: capabilities((current) => ({
            ...current,
            checkpointing: {
              ...current.checkpointing,
              providerRollbackReturnsSnapshot: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "rollback_snapshot");
    }),
  );

  it.effect("guards fork-delta handoff behind context handoff capabilities", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .ensureContextHandoff({
          commandId,
          threadId,
          provider: "codex",
          strategy: "fork_delta_context",
          capabilities: capabilities((current) => ({
            ...current,
            context: {
              ...current.context,
              supportsDeltaHandoff: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "context_handoff");
    }),
  );

  it.effect("guards queued turns behind queued-message support", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .ensureQueuedMessages({
          commandId,
          threadId,
          provider: "codex",
          capabilities: capabilities((current) => ({
            ...current,
            turns: {
              ...current.turns,
              supportsQueuedMessages: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "queued_messages");
    }),
  );
});
