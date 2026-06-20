import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ProviderCapabilities,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "./Adapters/CursorAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "./Adapters/GrokAdapterV2.ts";
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
        providerInstanceId: ProviderInstanceId.make("codex"),
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
        providerInstanceId: ProviderInstanceId.make("codex"),
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

  it.effect("uses interrupt-and-restart steering for Grok ACP", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("grok"),
        capabilities: GrokProviderCapabilitiesV2,
      });

      assert.equal(result, "interrupt_restart");
    }),
  );

  it.effect("honors an explicit interrupt-and-restart request", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: CodexProviderCapabilitiesV2,
        forceRestart: true,
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
          providerInstanceId: ProviderInstanceId.make("codex"),
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
          providerInstanceId: ProviderInstanceId.make("codex"),
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

  it.effect("uses a native fork when the provider supports the requested source point", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: CodexProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        fromSpecificTurn: true,
      });

      assert.equal(result, "native_fork");
    }),
  );

  it.effect("falls back to portable context when Cursor cannot fork natively", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        capabilities: CursorProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        fromSpecificTurn: true,
      });

      assert.equal(result, "portable_context");
    }),
  );

  it.effect("falls back to portable context when Grok ACP cannot fork natively", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("grok"),
        capabilities: GrokProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        fromSpecificTurn: true,
      });

      assert.equal(result, "portable_context");
    }),
  );

  it.effect("returns a typed error when neither native nor portable fork is available", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .decideForkExecution({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("cursor"),
          capabilities: capabilities((current) => ({
            ...current,
            threads: {
              ...current.threads,
              canForkThread: false,
            },
            context: {
              ...current.context,
              canConsumeHandoffSummaries: false,
            },
          })),
          sameProvider: true,
          hasStrongNativeSource: true,
          fromSpecificTurn: true,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "context_handoff");
    }),
  );

  it.effect("guards rollback behind provider rollback snapshot support", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicyV2;

      const error = yield* policy
        .ensureRollback({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
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
          providerInstanceId: ProviderInstanceId.make("codex"),
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
          providerInstanceId: ProviderInstanceId.make("codex"),
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
