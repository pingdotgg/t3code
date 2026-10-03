import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProviderAdapterV2HistoricalContext } from "./ProviderAdapter.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { historyCost, renderHistory, selectHistory } from "./ContextHandoffBudget.ts";

type ContextHandoffInput<BudgetError = never> = {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly budget: number | Effect.Effect<number, BudgetError>;
  readonly deferInline?: boolean;
  readonly alreadyDeliveredItemIds: ReadonlySet<string>;
};

export const prepareContextHandoffs = Effect.fn("orchestrationV2.prepareContextHandoffs")(
  function* <BudgetError = never>(input: ContextHandoffInput<BudgetError>) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0) return undefined;
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
    // Repeated failures can accumulate many recovery markers. Keep a single
    // thread-level entry point when detailed coverage would crowd out history;
    // its activity includes the original handoff/fork source references.
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    // Old preview handoffs remain readable. Their preformatted context is included
    // as a whole when it fits, otherwise the coverage marker points to retrieval.
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline) return undefined;
      return yield* new ContextHandoffBudgetError();
    }
    return { nativeThreadId, pending, selected };
  },
);

/** Persist before/after injection: an ambiguous pending delivery requires a fresh native thread. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(
    input: ContextHandoffInput<BudgetError> & {
      readonly inject?: (
        history: ProviderAdapterV2HistoricalContext,
      ) => Effect.Effect<boolean, InjectError>;
      readonly persist: (
        handoff: OrchestrationV2ContextHandoff,
      ) => Effect.Effect<void, PersistError>;
    },
  ) {
    if (input.deferInline && input.inject === undefined)
      return { context: "", delivered: Effect.void };
    const prepared = yield* prepareContextHandoffs(input);
    if (prepared === undefined) return { context: "", delivered: Effect.void };
    const { nativeThreadId, pending, selected } = prepared;
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
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
        return { context: "", delivered: Effect.void };
      }
    } else {
      // Text-only delivery can also be accepted before a connection drops.
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
    };
  },
);

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Use a larger-context model or reduce the request; the current request has not been truncated.";
  }
}
export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
