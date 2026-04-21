import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { Duration, Effect, Layer, Ref } from "effect";

import {
  ProviderRuntimeTransport,
  ProviderRuntimeIncompleteTranscriptError,
  ProviderRuntimeOutboundMismatchError,
  ProviderRuntimeTranscriptExhaustedError,
  ProviderRuntimeUnexpectedInboundPullError,
  ProviderRuntimeUnexpectedOutboundError,
  type ProviderRuntimeInbound,
  type ProviderRuntimeTransportShape,
} from "../Services/ProviderRuntimeTransport.ts";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function framesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function makeReplayProviderRuntime(
  transcript: ProviderReplayTranscript,
): Effect.Effect<ProviderRuntimeTransportShape> {
  return Effect.gen(function* () {
    const cursor = yield* Ref.make(0);

    const readNext = Ref.get(cursor).pipe(
      Effect.map((index) => ({
        index,
        entry: transcript.entries[index],
      })),
    );

    const advance = Ref.update(cursor, (index) => index + 1);

    const transport: ProviderRuntimeTransportShape = {
      send: (frame) =>
        Effect.gen(function* () {
          const { entry, index } = yield* readNext;
          if (!entry) {
            return yield* new ProviderRuntimeTranscriptExhaustedError({
              scenario: transcript.scenario,
              direction: "outbound",
              frame,
            });
          }
          if (entry.type !== "expect_outbound") {
            return yield* new ProviderRuntimeUnexpectedOutboundError({
              scenario: transcript.scenario,
              index,
              expectedEntry: entry,
              actualFrame: frame,
            });
          }
          if (!framesEqual(entry.frame, frame)) {
            return yield* new ProviderRuntimeOutboundMismatchError({
              scenario: transcript.scenario,
              index,
              expectedFrame: entry.frame,
              actualFrame: frame,
            });
          }
          yield* advance;
        }),
      receive: () =>
        Effect.gen(function* () {
          const { entry, index } = yield* readNext;
          if (!entry) {
            return yield* new ProviderRuntimeTranscriptExhaustedError({
              scenario: transcript.scenario,
              direction: "inbound",
            });
          }
          if (entry.type === "expect_outbound") {
            return yield* new ProviderRuntimeUnexpectedInboundPullError({
              scenario: transcript.scenario,
              index,
              expectedFrame: entry.frame,
            });
          }
          if (entry.type === "runtime_exit") {
            yield* advance;
            return entry satisfies ProviderRuntimeInbound;
          }
          if (entry.afterMs !== undefined && entry.afterMs > 0) {
            yield* Effect.sleep(Duration.millis(entry.afterMs));
          }
          yield* advance;
          return {
            type: "frame",
            frame: entry.frame,
          } satisfies ProviderRuntimeInbound;
        }),
      assertComplete: () =>
        Effect.gen(function* () {
          const index = yield* Ref.get(cursor);
          if (index !== transcript.entries.length) {
            return yield* new ProviderRuntimeIncompleteTranscriptError({
              scenario: transcript.scenario,
              index,
              total: transcript.entries.length,
              nextEntry: transcript.entries[index],
            });
          }
        }),
    };

    return transport;
  });
}

export function makeReplayProviderRuntimeLayer(
  transcript: ProviderReplayTranscript,
): Layer.Layer<ProviderRuntimeTransport> {
  return Layer.effect(ProviderRuntimeTransport, makeReplayProviderRuntime(transcript));
}
