import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
  ProjectFactId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { HandoffSummary } from "../project/conversationSummaries/conversationSummarySchedule.ts";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import { conversationEvidenceText } from "@t3tools/provider-core/server/conversationEvidence";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

// Matches the messages the summary pass never covers, so the latest exchange stays verbatim.
const FRESH_TAIL_MESSAGES = 6;

const MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "peer_reply",
]);

export function freshTailMessages<Message extends { readonly kind?: string }>(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> {
  return messages
    .filter((message) => message.kind !== undefined && MESSAGE_KINDS.has(message.kind))
    .slice(-FRESH_TAIL_MESSAGES);
}

const SUMMARY_TOOLS = "t3_conversation_summary_list and t3_conversation_summary_expand";

const REPLACED_SPANS_PREFIX = "Replaced earlier spans with ";
const OMITTED_SUMMARY_PREFIX = "Some omitted items have conversation summaries; read one with ";
const RECEIPT_PREFIXES = [REPLACED_SPANS_PREFIX, OMITTED_SUMMARY_PREFIX] as const;

function handoffReceiptLine(input: {
  readonly summaryIds: ReadonlyArray<string>;
  readonly omittedHaveSummaries: boolean;
}): string {
  if (input.summaryIds.length > 0) {
    return `${REPLACED_SPANS_PREFIX}${input.summaryIds.join(", ")}; read one with ${SUMMARY_TOOLS}.`;
  }
  if (input.omittedHaveSummaries) {
    return `${OMITTED_SUMMARY_PREFIX}${SUMMARY_TOOLS}.`;
  }
  return "";
}

const STUBBED_ITEMS = 5;
const NOT_SHOWN_LINES = 3;

const summaryCount = (count: number, adjective: string) =>
  `${count} ${adjective} ${count === 1 ? "summary holds" : "summaries hold"} omitted items`;
const listCall = (offer: HandoffSummary) =>
  `t3_conversation_summary_list({projectId:"${offer.projectId}",threadId:"${offer.threadId}"})`;

/**
 * Where to read omitted items held by summaries that did not fit, nearest the present first. A
 * delivered summary needs no line: its header already names its expand call. Agents are not told
 * their project id. Lines give way from the far end; when none fits, one line names the list call.
 */
function notShownBlock(input: {
  readonly offers: ReadonlyArray<HandoffSummary>;
  readonly omitted: ReadonlySet<string>;
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly fits: (block: string) => boolean;
}) {
  const lines = notShownLines(input);
  if (lines.length === 0) return { text: "", fallback: "" };
  const fallback = `Not shown here: ${summaryCount(lines.length, "conversation")}; list them with ${listCall(lines[0]!.offer)}.`;
  for (let shown = Math.min(lines.length, NOT_SHOWN_LINES); shown > 0; shown--) {
    const rest = lines.slice(shown);
    const block = [
      ...lines.slice(0, shown).map(({ line }) => line),
      ...(rest.length === 0
        ? []
        : [`${summaryCount(rest.length, "more")}; list them with ${listCall(rest[0]!.offer)}.`]),
    ].join("\n");
    if (input.fits(block)) return { text: block, fallback };
  }
  return { text: input.fits(fallback) ? fallback : "", fallback };
}

function notShownLines(input: {
  readonly offers: ReadonlyArray<HandoffSummary>;
  readonly omitted: ReadonlySet<string>;
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
}): ReadonlyArray<{ readonly offer: HandoffSummary; readonly line: string }> {
  const byId = new Map(input.messages.map((message) => [message.itemId, message]));
  return input.offers.flatMap((offer) => {
    const covered = offer.coveredItemIds.filter((id) => input.omitted.has(id));
    if (covered.length === 0) return [];
    const stubs = covered
      .flatMap((id) => {
        const message = byId.get(id);
        return message?.kind === undefined || MESSAGE_KINDS.has(message.kind) ? [] : [message];
      })
      .slice(-STUBBED_ITEMS)
      .map((tool) => `${tool.itemId} (${tool.kind}: ${tool.text.split("\n", 1)[0]!.slice(0, 80)})`);
    const more = covered.length - stubs.length;
    const ids = offer.summaryIds ?? [offer.id];
    return [
      {
        offer,
        line: `Not shown here: ${[...stubs, ...(more > 0 ? [`${more} ${stubs.length > 0 ? "more " : ""}omitted item${more === 1 ? "" : "s"}`] : [])].join(", ")}. ${ids.join(", ")} ${ids.length === 1 ? "holds" : "hold"} the original text; read it with t3_conversation_summary_expand({projectId:"${offer.projectId}",threadId:"${offer.threadId}",summaryId:"${ids[0]}"})${ids.length === 1 ? "" : " and the other ids"}.`,
      },
    ];
  });
}

function withoutHandoffReceipt(summaryText: string): string {
  return summaryText
    .split("\n")
    .filter((line) => !RECEIPT_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join("\n");
}

function withHandoffReceipt(summaryText: string, line: string): string {
  const base = withoutHandoffReceipt(summaryText);
  if (line === "") return base;
  return base === "" ? line : `${base}\n${line}`;
}

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
    readonly onDelivered?: (
      messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
      summaryFactIds: ReadonlyArray<ProjectFactId>,
    ) => Effect.Effect<void, EvidenceError>;
    /**
     * Current conversation summaries that cover some of `itemIds`, nearest the present first,
     * none overlapping another. One may take the place of the history items it covers when the
     * budget omits history.
     */
    readonly summaries?: (
      itemIds: ReadonlySet<string>,
    ) => Effect.Effect<ReadonlyArray<HandoffSummary>>;
  }) {
    const empty = {
      context: "",
      messages: [] as ReadonlyArray<OrchestrationV2HistoricalMessage>,
      summaryFactIds: [] as ReadonlyArray<ProjectFactId>,
      delivered: Effect.void,
      unsent: Effect.void,
      uncoveredItems: 0,
    };
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined)) return empty;
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
      const text = conversationEvidenceText(message.text);
      return {
        ...message,
        text: attached === undefined ? text : `${text}\n\n${conversationEvidenceText(attached)}`,
      };
    });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => conversationEvidenceText(handoff.summaryText))
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const priorOmittedCount = pending.reduce(
      (sum, handoff) => sum + (handoff.history?.omittedItems ?? 0),
      0,
    );
    const freshTail = new Set<string>(freshTailMessages(messages).map((message) => message.itemId));
    let selection: Parameters<typeof selectHistory>[0] = {
      messages,
      coverage: fullCoverage,
      omittedItems: priorOmittedCount,
      omittedItemIds: pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
      budget,
      first: freshTail,
    };
    let selected = selectHistory(selection);
    const summarized = new Set<TurnItemId>();
    const chosen: Array<HandoffSummary> = [];
    let offered: ReadonlyArray<HandoffSummary> = [];
    const priorOmitted = new Set<TurnItemId>(
      pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
    );
    if (
      input.summaries !== undefined &&
      (priorOmitted.size > 0 || selected.omittedItemIds.length > 0)
    ) {
      // The newest messages stay verbatim when they fit. Tool results around them may give way
      // to a summary.
      const pinned = new Set<string>(
        selected.messages.flatMap((message) =>
          freshTail.has(message.itemId) ? [message.itemId] : [],
        ),
      );
      const eligible = new Set(
        [...priorOmitted, ...messages.map((message) => message.itemId)].filter(
          (id) => !pinned.has(id) && !input.alreadyDeliveredItemIds.has(id),
        ),
      );
      // Most covered items per byte first, so coarse summaries of old history come before the
      // finer ones next to the tail. Ties keep the offered order, nearest the present first.
      offered = yield* input.summaries(eligible);
      const offers = offered.toSorted(
        (a, b) =>
          b.coveredItemIds.length / Buffer.byteLength(b.text) -
          a.coveredItemIds.length / Buffer.byteLength(a.text),
      );
      for (const candidate of offers) {
        if (candidate.coveredItemIds.some((id) => summarized.has(id) || !eligible.has(id)))
          continue;
        const proposed = new Set([...summarized, ...candidate.coveredItemIds]);
        const summaryBlock = [...chosen, candidate].map((summary) => summary.text).join("\n\n");
        const proposedIds = new Set<string>(proposed);
        const proposedSelection = {
          messages: messages.filter((message) => !proposed.has(message.itemId)),
          coverage: `${fullCoverage}\n${proposed.size} older items are represented by the generated conversation summaries below instead of verbatim.\n${summaryBlock}`,
          omittedItems:
            priorOmittedCount - [...proposed].filter((id) => priorOmitted.has(id)).length,
          omittedItemIds: [...priorOmitted].filter((id) => !proposedIds.has(id)),
          budget,
          // Otherwise a newer tool result takes the room an older pinned message needs, and
          // the summary is refused for a loss it did not have to cause.
          first: pinned,
        };
        const reduced = selectHistory(proposedSelection);
        // A summary earns its space only when more history arrives with it than without it.
        const kept = new Set<string>(reduced.messages.map((message) => message.itemId));
        if (
          historyCost(reduced.messages, reduced.context) > budget ||
          [...pinned].some((id) => !kept.has(id)) ||
          kept.size + proposed.size <= selected.messages.length + summarized.size
        )
          continue;
        chosen.push(candidate);
        for (const id of candidate.coveredItemIds) summarized.add(id);
        selection = proposedSelection;
        selected = reduced;
      }
    }
    const notShown = () =>
      notShownBlock({
        offers: offered.filter((offer) => !chosen.includes(offer)),
        omitted: new Set(
          [...priorOmitted, ...selected.omittedItemIds].filter((id) => !summarized.has(id)),
        ),
        messages,
        fits: (block) => historyCost(selected.messages, `${selected.context}\n${block}`) <= budget,
      });
    let pointer = notShown();
    let reserved = 0;
    while (pointer.text === "" && pointer.fallback !== "") {
      const reserve =
        historyCost(selected.messages, `${selected.context}\n${pointer.fallback}`) -
        historyCost(selected.messages, selected.context);
      if (reserve <= reserved) break;
      const reduced = selectHistory({ ...selection, budget: budget - reserve });
      const kept = new Set<string>(reduced.messages.map((message) => message.itemId));
      // Older optional history yields to recovery instructions; the fresh tail stays pinned.
      if (
        selected.messages.some(
          (message) => freshTail.has(message.itemId) && !kept.has(message.itemId),
        )
      )
        break;
      reserved = reserve;
      selected = reduced;
      pointer = notShown();
    }
    const summaryFactIds = [
      ...new Set(chosen.flatMap((summary) => summary.knowledgeFactIds ?? [])),
    ];
    const omittedItemIds = new Set(selected.omittedItemIds);
    // Items that arrive neither verbatim nor beneath a delivered summary. An older record may
    // count omitted items without naming them, or carry only text that did not fit: both count,
    // because nothing shows they are covered. Deferred history waits for a later turn instead.
    const uncoveredItems =
      omittedItemIds.size +
      pending.reduce((sum, handoff) => {
        if (handoff.history === undefined)
          return sum + (handoff.summaryText !== "" && fullCoverage === coverage ? 1 : 0);
        const named = handoff.history.omittedItemIds;
        return (
          sum +
          (named === undefined
            ? handoff.history.omittedItems
            : named.filter((id) => !summarized.has(id)).length)
        );
      }, 0);
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
    const stillOmitted = (handoff: OrchestrationV2ContextHandoff) =>
      new Set<TurnItemId>([
        ...(handoff.history?.omittedItemIds ?? []).filter((id) => !summarized.has(id)),
        ...(handoff.history?.messages ?? [])
          .filter((message) => omittedItemIds.has(message.itemId))
          .map((message) => message.itemId),
      ]);
    const omittedHaveSummaries = (ids: ReadonlySet<string>) =>
      offered.some((offer) => offer.coveredItemIds.some((id) => ids.has(id)));
    const receiptFor = (handoff: OrchestrationV2ContextHandoff) =>
      withHandoffReceipt(
        handoff.summaryText,
        handoffReceiptLine({
          summaryIds: summaryDelivery(handoff).summaryIds ?? [],
          omittedHaveSummaries: omittedHaveSummaries(stillOmitted(handoff)),
        }),
      );
    const context = pointer.text === "" ? selected.context : `${selected.context}\n${pointer.text}`;
    const estimatedTokens = historyCost(selected.messages, context);
    if (estimatedTokens > budget) {
      if (input.deferInline) return empty;
      return yield* new ContextHandoffBudgetError();
    }
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff, index) =>
          input.persist({
            ...handoff,
            summaryText: receiptFor(handoff),
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    estimatedTokens: index === 0 ? estimatedTokens : 0,
                    omittedItemIds: [...stillOmitted(handoff)],
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
        context,
      });
      if (injected) {
        yield* persist("injected");
        yield* input.onDelivered?.(selected.messages, summaryFactIds) ?? Effect.void;
        return {
          context: "",
          messages: selected.messages,
          summaryFactIds,
          delivered: Effect.void,
          unsent: Effect.void,
          uncoveredItems,
        };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return empty;
    }
    return {
      uncoveredItems,
      context: renderHistory(selected.messages, context),
      messages: selected.messages,
      summaryFactIds,
      delivered: persist("inline").pipe(
        Effect.andThen(input.onDelivered?.(selected.messages, summaryFactIds) ?? Effect.void),
      ),
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
