/**
 * OpenCode provider tags and native message id generation.
 */
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

export const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");

export const OPENCODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_PROVIDER);

export const OPENCODE_SDK_PROTOCOL = "opencode-sdk.sse" as const;

export const makeOpenCodeMessageId = Effect.fnUntraced(function* (
  clock: Ref.Ref<{ readonly epochMillis: number; readonly counter: number }>,
) {
  const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
  const counter = yield* Ref.modify(clock, (previous) => {
    const next = previous.epochMillis === epochMillis ? previous.counter + 1 : 1;
    return [next, { epochMillis, counter: next }] as const;
  });
  const encodedTime = BigInt.asUintN(48, BigInt(epochMillis) * 0x1000n + BigInt(counter))
    .toString(16)
    .padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = (yield* Effect.forEach(Array.from({ length: 28 }), () =>
    Random.nextIntBetween(0, alphabet.length - 1),
  ))
    .map((index) => alphabet[index])
    .join("");
  return `msg_${encodedTime}${random}`;
});

// OpenCode has no turn object; correlate by initiating user message and settle on session idle.
