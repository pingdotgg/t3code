import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { HandoffSummary } from "../project/conversationSummaries/conversationSummarySchedule.ts";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

// Matches the tail summaries never cover, so the latest exchange always arrives verbatim.
const FRESH_TAIL_ITEMS = 6;

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

/** Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <
    InjectError = never,
    PersistError = never,
    BudgetError = never,
    EvidenceError = never,
  >(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
    /**
     * Text the provider originally received alongside a historical message but that the message
     * text does not carry (such as project knowledge sent with it), keyed by item id. Rendered
     * with the message so it shares its budget and per-native-thread delivery marker.
     */
    readonly evidence?: (
      messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
    ) => Effect.Effect<ReadonlyMap<string, string>, EvidenceError>;
    /**
     * Current conversation summaries whose sources are all among `itemIds`, oldest first. One
     * may replace the history items it covers when the budget would otherwise omit them.
     */
    readonly summaries?: (
      itemIds: ReadonlySet<string>,
    ) => Effect.Effect<ReadonlyArray<HandoffSummary>>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const uniqueMessages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    const evidence =
      input.evidence === undefined || uniqueMessages.length === 0
        ? new Map<string, string>()
        : yield* input.evidence(uniqueMessages);
    const messages = uniqueMessages.map((message) => {
      const attached = evidence.get(message.itemId);
      return attached === undefined
        ? message
        : { ...message, text: `${message.text}\n\n${attached}` };
    });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const priorOmittedCount = pending.reduce(
      (sum, handoff) => sum + (handoff.history?.omittedItems ?? 0),
      0,
    );
    let selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: priorOmittedCount,
      budget,
    });
    const summarized = new Set<TurnItemId>();
    const chosen: Array<HandoffSummary> = [];
    const priorOmitted = new Set<string>(
      pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
    );
    if (
      input.summaries !== undefined &&
      (priorOmitted.size > 0 || selected.omittedItemIds.length > 0)
    ) {
      // The newest messages stay verbatim; summaries only stand in for older history.
      const tail = new Set<string>(
        messages.slice(-FRESH_TAIL_ITEMS).map((message) => message.itemId),
      );
      const eligible = new Set(
        [...priorOmitted, ...messages.map((message) => message.itemId)].filter(
          (id) => !tail.has(id) && !input.alreadyDeliveredItemIds.has(id),
        ),
      );
      for (const candidate of yield* input.summaries(eligible)) {
        const omittedNow = new Set([...priorOmitted, ...selected.omittedItemIds]);
        if (
          !candidate.coveredItemIds.some((id) => omittedNow.has(id)) ||
          candidate.coveredItemIds.some((id) => summarized.has(id) || !eligible.has(id))
        )
          continue;
        const proposed = new Set([...summarized, ...candidate.coveredItemIds]);
        const summaryBlock = [...chosen, candidate].map((summary) => summary.text).join("\n\n");
        const reduced = selectHistory({
          messages: messages.filter((message) => !proposed.has(message.itemId)),
          coverage: `${fullCoverage}\n${proposed.size} older items are represented by the generated conversation summaries below instead of verbatim.\n${summaryBlock}`,
          omittedItems:
            priorOmittedCount - [...proposed].filter((id) => priorOmitted.has(id)).length,
          budget,
        });
        const keptTail = selected.messages.filter((message) => tail.has(message.itemId));
        if (
          historyCost(reduced.messages, reduced.context) > budget ||
          keptTail.some(
            (message) => !reduced.messages.some((kept) => kept.itemId === message.itemId),
          )
        )
          continue;
        chosen.push(candidate);
        for (const id of candidate.coveredItemIds) summarized.add(id);
        selected = reduced;
      }
    }
    const estimatedTokens = historyCost(selected.messages, selected.context);
    if (estimatedTokens > budget) {
      if (input.deferInline) return { context: "", delivered: Effect.void, unsent: Effect.void };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const summaryDelivery = (handoff: OrchestrationV2ContextHandoff) => {
      const own = new Set<string>([
        ...(handoff.history?.omittedItemIds ?? []),
        ...(handoff.history?.messages ?? []).map((message) => message.itemId),
      ]);
      const summarizedItemIds = [...summarized].filter((id) => own.has(id));
      if (summarizedItemIds.length === 0) return {};
      return {
        summaryIds: chosen
          .filter((summary) => summary.coveredItemIds.some((id) => own.has(id)))
          .flatMap((summary) => summary.summaryIds ?? [summary.id]),
        summarizedItemIds,
      };
    };
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff, index) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    estimatedTokens: index === 0 ? estimatedTokens : 0,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []).filter(
                        (id) => !summarized.has(id),
                      ),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    ...summaryDelivery(handoff),
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, input.persist, { discard: true }),
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
