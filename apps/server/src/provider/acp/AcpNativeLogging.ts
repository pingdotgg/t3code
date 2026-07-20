import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "../NativeProtocolLogging.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  return {
    method: structuralProtocolMethod(event.method),
    status: event.status,
    request: summarizeNativeProtocolPayload(event.payload),
    ...(event.result !== undefined ? { result: summarizeNativeProtocolPayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
        }
      : {}),
  };
}

export function formatAcpProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizeNativeProtocolPayload(event.payload),
  };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = (logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                writeNativeAcpLog({
                  kind: "protocol",
                  payload: formatAcpProtocolLogPayload(event),
                }),
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
