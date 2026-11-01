import {
  type OrchestrationV2AppThread,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
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

import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffCoverage,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export class ContextHandoffPrepareError extends Schema.TaggedError<ContextHandoffPrepareError>()(
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
  readonly prepareLegacyImport: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly toProviderThreadId: ProviderThreadId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
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
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  /** Parent activity after the fork point, prepended to a side chat's first provider turn. */
  readonly prepareSideChatContext: (input: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
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

export function visibleDeltaRunOrdinals(
  projection: { readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">> },
  items: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId">>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinalByRunId = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  let from = Infinity;
  let to = -Infinity;
  for (const item of items) {
    const ordinal = item.runId === null ? undefined : ordinalByRunId.get(item.runId);
    if (ordinal === undefined) continue;
    from = Math.min(from, ordinal);
    to = Math.max(to, ordinal);
  }
  return from === Infinity ? { from: 1, to: 1 } : { from, to };
}

/** Drops rolled-back runs and cancelled queued messages, which are not part of the conversation. */
export function visibleConversationItems(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const visible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items,
  });
  return items.filter(visible);
}

type ForkHistorySource = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">;

/** Visible rows of `source`'s own runs through `throughRun`, plus its v1 imported rows. */
const readOwnHistoryItems = Effect.fn("orchestrationV2.contextHandoff.readOwnHistoryItems")(
  function* (
    projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
    source: ForkHistorySource,
    throughRun: Pick<OrchestrationV2Run, "ordinal">,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(source.thread.id, ["turnItems"], {
      turnItemRunIds: [
        ...source.runs.filter((run) => run.ordinal <= throughRun.ordinal).map((run) => run.id),
        ...(source.thread.historyOrigin === "v1_import" ? [null] : []),
      ],
    });
    return visibleConversationItems(source, turnItems);
  },
);

/** History `thread` shows from its fork ancestors, oldest first. Side chats inherit no rows. */
export const readInheritedHandoffItems = Effect.fn(
  "orchestrationV2.contextHandoff.readInheritedHandoffItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  thread: OrchestrationV2AppThread,
) {
  const segments: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
  const seen = new Set([thread.id]);
  let current = thread;
  while (
    current.forkedFrom?.type === "run" &&
    current.lineage.sideChat !== true &&
    !seen.has(current.forkedFrom.threadId)
  ) {
    const { threadId, runId } = current.forkedFrom;
    seen.add(threadId);
    const source = yield* projectionStore
      .getThreadRecords(threadId, ["runs", "attempts"])
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const forkRun = source?.runs.find((run) => run.id === runId);
    if (source === null || forkRun === undefined) break;
    segments.unshift(yield* readOwnHistoryItems(projectionStore, source, forkRun));
    current = source.thread;
  }
  return segments.flat();
});

/** What a portable fork from `throughRun` of `source` carries: inherited rows, then its own. */
export const readForkHistoryItems = Effect.fn(
  "orchestrationV2.contextHandoff.readForkHistoryItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  source: ForkHistorySource,
  throughRun: Pick<OrchestrationV2Run, "ordinal">,
) {
  return [
    ...(yield* readInheritedHandoffItems(projectionStore, source.thread)),
    ...(yield* readOwnHistoryItems(projectionStore, source, throughRun)),
  ];
});

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

const SIDE_CHAT_CONTEXT_MAX_CHARS = 8_000;

/** Oldest first; raw parent items are summarized only until the context cap is reached. */
export function makeSideChatContext(input: {
  readonly parentThreadId: ThreadId;
  readonly digest: ReadonlyArray<string | OrchestrationV2TurnItem>;
}): string {
  const framing =
    "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.";
  const header = "Main thread activity since this side chat's starting point:";
  const truncated = "- Earlier items truncated.";
  const footer = `Use t3_thread_read on thread ${input.parentThreadId} to see the main thread's live state.`;
  const kept: Array<string> = [];
  let omitted = false;
  // The cap covers the whole block, so the fixed lines are reserved before any digest line.
  let remaining =
    SIDE_CHAT_CONTEXT_MAX_CHARS - [framing, "", header, truncated, "", footer].join("\n").length;
  for (let index = input.digest.length - 1; index >= 0; index--) {
    const item = input.digest[index]!;
    const line = typeof item === "string" ? item : summarizeDeltaItem(item);
    if (line === null) continue;
    if (line.length + 1 > remaining) {
      omitted = true;
      break;
    }
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return [
    framing,
    ...(kept.length === 0 ? [] : ["", header, ...(omitted ? [truncated] : []), ...kept]),
    "",
    footer,
  ].join("\n");
}

/** Side chat context is prepended to the provider prompt, never replayed as budgeted history. */
export const isSideChatContextHandoff = (handoff: OrchestrationV2ContextHandoff): boolean =>
  handoff.strategy === "manual_context" && handoff.transferId != null;

function makeLegacyImportSummary(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return [{ label: "User", body: item.text }];
      case "assistant_message":
        return [{ label: "Assistant", body: item.text }];
      default:
        return [];
    }
  });
  const header =
    "Imported conversation history from the previous T3 Code orchestrator. Use it as context; do not repeat it unless the user asks.";
  const maxChars = 32_000;
  const selected: Array<string> = [];
  let remaining = maxChars - header.length - 2;
  for (const section of sections.toReversed()) {
    if (remaining <= 0) break;
    const fullSection = `${section.label}:\n${section.body}`;
    if (fullSection.length <= remaining) {
      selected.unshift(fullSection);
      remaining -= fullSection.length + 2;
      continue;
    }

    const prefix = `${section.label}:\n... `;
    const bodyBudget = remaining - prefix.length;
    if (bodyBudget <= 0) continue;

    const initialStart = section.body.length - bodyBudget;
    let bodyStart = Math.max(0, initialStart);
    if (
      bodyStart > 0 &&
      !/\s/.test(section.body[bodyStart - 1] ?? "") &&
      !/\s/.test(section.body[bodyStart] ?? "")
    ) {
      const nextWhitespace = section.body.slice(bodyStart).search(/\s/);
      if (nextWhitespace !== -1) {
        bodyStart += nextWhitespace;
      }
    }
    const codeUnitAtStart = section.body.charCodeAt(bodyStart);
    const codeUnitBeforeStart = section.body.charCodeAt(bodyStart - 1);
    if (
      codeUnitAtStart >= 0xdc00 &&
      codeUnitAtStart <= 0xdfff &&
      codeUnitBeforeStart >= 0xd800 &&
      codeUnitBeforeStart <= 0xdbff
    ) {
      bodyStart += 1;
    }
    const bodySuffix = section.body.slice(bodyStart).trimStart();
    if (bodySuffix.length === 0) continue;

    const suffix = `${prefix}${bodySuffix}`;
    selected.unshift(suffix);
    remaining -= suffix.length + 2;
  }
  return [header, ...selected].join("\n\n");
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const tokenCap = yield* handoffTokenCapConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
    );

    const prepareLegacyImport = Effect.fn("orchestrationV2.contextHandoff.prepareLegacyImport")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly targetRunId: RunId;
        readonly toProviderThreadId: ProviderThreadId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: ProviderInstanceId.make("legacy"),
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({ ...input, coveredRunOrdinals: { from: 1, to: 1 } });
        const selected = selectHistory({
          messages: input.items.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: null,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeLegacyImportSummary(input.items),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

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
        const coverage = handoffCoverage({
          threadId: input.sourceThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          items: input.deltaItems,
        });
        const selected = selectHistory({
          messages: input.deltaItems.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
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
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
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
      readonly transferId: OrchestrationV2ContextHandoff["transferId"];
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly runs?: ReadonlyArray<OrchestrationV2Run>;
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
      const runStatuses = new Map(input.runs?.map((run) => [run.id, run.status]));
      const coverage = handoffCoverage(input);
      const selected = selectHistory({
        messages: input.items.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null
            ? []
            : [
                {
                  ...message,
                  ...(item.runId === null ? {} : { runStatus: runStatuses.get(item.runId) }),
                },
              ];
        }),
        coverage,
        budget: tokenCap,
      });
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
        summaryText: renderHistory(selected.messages, selected.context),
        history: {
          messages: selected.messages,
          coverage,
          omittedItems: selected.omittedItems,
          omittedItemIds: selected.omittedItemIds,
        },
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareSideChatContext = Effect.fn(
      "orchestrationV2.contextHandoff.prepareSideChatContext",
    )(function* (input: Parameters<ContextHandoffServiceV2Shape["prepareSideChatContext"]>[0]) {
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
                fromProviderThreadIds: [],
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
        fromProviderThreadIds: [],
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: makeSideChatContext({
          parentThreadId: input.parentThreadId,
          digest: input.parentItems,
        }),
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    return ContextHandoffServiceV2.of({
      prepareLegacyImport,
      prepareForkDelta,
      prepareProviderHandoff,
      prepareSideChatContext,
    });
  },
);

export const layer: Layer.Layer<ContextHandoffServiceV2, never, IdAllocator.IdAllocatorV2> =
  Layer.effect(ContextHandoffServiceV2, makeContextHandoffService());
