import {
  OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { IdAllocatorV2 } from "./IdAllocator.ts";

export class ContextHandoffPrepareError extends Schema.TaggedErrorClass<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareForkDelta: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareProviderHandoff: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/ContextHandoffService/ContextHandoffServiceV2") {}

function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function summarizeDeltaItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `- User: ${compactText(item.text)}`;
    case "assistant_message":
      return `- Assistant: ${compactText(item.text)}`;
    case "command_execution":
      return `- Command: ${compactText(item.input)}`;
    case "file_change":
      return `- File change: ${item.fileName}`;
    case "checkpoint":
      return `- Checkpoint: ${item.files.length} files`;
    case "handoff":
      return `- Handoff: ${compactText(item.summary ?? item.strategy)}`;
    default:
      return null;
  }
}

function makeForkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const itemLines = input.deltaItems.flatMap((item) => {
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    `Covered fork runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
    "Fork delta:",
    ...(itemLines.length === 0 ? ["- No user-visible delta items."] : itemLines),
  ].join("\n");
}

function makeProviderHandoffSummary(input: {
  readonly fromProviderInstanceId: ProviderInstanceId;
  readonly toProviderInstanceId: ProviderInstanceId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly strategy: Extract<
    OrchestrationV2ContextHandoff["strategy"],
    "delta_since_target_last_seen" | "full_thread_summary"
  >;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const itemLines = input.items.flatMap((item) => {
    if (item.type === "handoff") {
      return [];
    }
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    input.strategy === "full_thread_summary"
      ? "Full conversation context for provider handoff."
      : "Conversation delta since this provider last participated.",
    `From driver: ${input.fromProviderInstanceId}`,
    `To driver: ${input.toProviderInstanceId}`,
    `Covered app runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
    "Canonical conversation context:",
    ...(itemLines.length === 0 ? ["- No user-visible context items."] : itemLines),
  ].join("\n");
}

export function providerMessageWithContextHandoff(input: {
  readonly handoff: OrchestrationV2ContextHandoff;
  readonly userText: string;
}): string {
  return providerMessageWithContextHandoffs({
    handoffs: [input.handoff],
    userText: input.userText,
  });
}

export function providerMessageWithContextHandoffs(input: {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly userText: string;
}): string {
  const handoffSections = input.handoffs.flatMap((handoff) => {
    const label =
      handoff.strategy === "fork_delta_summary"
        ? "merge_back / fork_delta_summary"
        : handoff.strategy;
    return [`Context handoff (${label}):`, handoff.summaryText, ""];
  });
  return [...handoffSections, "User message:", input.userText].join("\n");
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocatorV2;

    const prepare = Effect.fn("orchestrationV2.contextHandoff.prepare")(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
    }) {
      const now = yield* DateTime.now;
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: ProviderInstanceId.make("manual"),
          toProviderInstanceId: ProviderInstanceId.make("manual"),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: null,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: "Manual context handoff.",
        createdByProviderInstanceId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareForkDelta = Effect.fn("orchestrationV2.contextHandoff.prepareForkDelta")(
      function* (input: {
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId: ThreadId;
        readonly targetRunId: RunId;
        readonly transferId: OrchestrationV2ContextHandoff["transferId"];
        readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
        readonly toProviderThreadId: ProviderThreadId;
        readonly fromProviderInstanceId: ProviderInstanceId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
        readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeForkDeltaSummary(input),
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareProviderHandoff = Effect.fn(
      "orchestrationV2.contextHandoff.prepareProviderHandoff",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly strategy: Extract<
        OrchestrationV2ContextHandoff["strategy"],
        "delta_since_target_last_seen" | "full_thread_summary"
      >;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly createdAt: DateTime.Utc;
    }) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: input.strategy,
        status: "ready",
        summaryMessageId: null,
        summaryText: makeProviderHandoffSummary(input),
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    return ContextHandoffServiceV2.of({
      prepare,
      prepareForkDelta,
      prepareProviderHandoff,
    });
  },
);

export const layer: Layer.Layer<ContextHandoffServiceV2, never, IdAllocatorV2> = Layer.effect(
  ContextHandoffServiceV2,
  makeContextHandoffService(),
);
