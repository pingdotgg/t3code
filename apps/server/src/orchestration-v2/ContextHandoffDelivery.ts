import {
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

/**
 * A ready handoff stays `ready` after delivery. The next turn on its provider thread redelivers it
 * only when its target run failed, was interrupted or cancelled, or was a completed compaction or `/goal` turn
 * that never recorded a delivery: those turns defer history to the next turn.
 */
export const isContextHandoffRedeliverable = (
  handoff: OrchestrationV2ContextHandoff,
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
) =>
  runs.some(
    (source) =>
      source.id === handoff.targetRunId &&
      (source.status === "failed" ||
        source.status === "interrupted" ||
        source.status === "cancelled" ||
        (source.status === "completed" &&
          handoff.delivery === undefined &&
          messages.some(
            (message) =>
              message.id === source.userMessageId &&
              (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
          ))),
  );

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

const NOTIFICATION_DETAIL_LIMIT = 20_000;

/** Caps text shown in a turn item, which travels over the websocket, and says how much was cut. */
export const capNotificationDetail = (text: string, limit = NOTIFICATION_DETAIL_LIMIT): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[${(text.length - limit).toLocaleString("en-US")} more characters not shown]`;

/** The notification that shows the user what T3 Code added to a turn; undefined when it added nothing. */
export const turnAddedContextNotification = (
  parts: ReadonlyArray<{ readonly label: string; readonly text: string }>,
): OrchestrationV2Notification | undefined => {
  const sent = parts.filter((part) => part.text !== "");
  if (sent.length === 0) return undefined;
  return {
    source: { kind: "system" },
    outcome: "updated",
    summary: `T3 Code added context to this turn: ${sent.map((part) => part.label).join(", ")}`,
    detail: capNotificationDetail(sent.map((part) => `[${part.label}]\n${part.text}`).join("\n\n")),
  };
};

/** The notification that shows the user what T3 Code held back from a turn because its setting is off. */
export const turnNotSentNotification = (
  label: string,
  detail?: string,
): OrchestrationV2Notification => ({
  source: { kind: "system" },
  outcome: "cancelled",
  summary: `T3 Code did not send the ${label} (switched off in Settings)`,
  ...(detail === undefined || detail === "" ? {} : { detail: capNotificationDetail(detail) }),
});

/**
 * Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption.
 * A handoff `suppress` picks is not sent: `delivered` settles it as delivered with every item omitted.
 */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly suppress?: ((handoff: OrchestrationV2ContextHandoff) => boolean) | undefined;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const undelivered = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    const held = input.suppress === undefined ? [] : undelivered.filter(input.suppress);
    const pending = undelivered.filter((handoff) => !held.includes(handoff));
    const suppressed = held.length > 0;
    const settleHeld = Effect.forEach(
      held,
      (handoff) =>
        input.persist({
          ...handoff,
          ...(nativeThreadId === undefined
            ? {}
            : {
                delivery: {
                  nativeThreadId,
                  status: "inline" as const,
                  itemIds: [],
                  omittedItemIds: [
                    ...(handoff.history?.omittedItemIds ?? []),
                    ...(handoff.history?.messages ?? []).map((message) => message.itemId),
                  ],
                },
              }),
        }),
      { discard: true },
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return {
        context: "",
        injected: false,
        suppressed,
        delivered: settleHeld,
        unsent: Effect.void,
      };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity, afterPosition=-1; paginate with afterPosition=nextPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover an omitted item only when the request needs it, with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",itemId:"<omitted item ID>",maxCharsPerItem:4000}); continue long text with textOffset=nextTextOffset until null. Follow fork/handoff source references in activity. Items included below need no read.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
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
      omittedItemIds: pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline)
        return {
          context: "",
          injected: false,
          suppressed,
          delivered: settleHeld,
          unsent: Effect.void,
        };
      return yield* new ContextHandoffBudgetError();
    }
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
        return {
          context: "",
          injected: true,
          suppressed,
          delivered: settleHeld,
          unsent: Effect.void,
        };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return {
        context: "",
        injected: false,
        suppressed,
        delivered: settleHeld,
        unsent: Effect.void,
      };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      injected: false,
      suppressed,
      delivered: persist("inline").pipe(Effect.andThen(settleHeld)),
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
