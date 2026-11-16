import {
  parseGoalCommand,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import { compactText } from "./ContextHandoffService.ts";

// Bounds the notice so it always fits beside the coverage marker; history is trimmed first.
const GOAL_OBJECTIVE_MAX_CHARS = 400;

/** What delivery reads to find the unfinished goals other native sessions still own. */
export type GoalOwnershipSources = Pick<
  OrchestrationV2ThreadProjection,
  "providerThreads" | "contextHandoffs" | "runs" | "messages"
>;

/**
 * Names the unfinished goals other native sessions of the thread still own. A live session's goal
 * is read from its provider thread at delivery, so a cleared goal is not repeated. A session a
 * failed resume replaced is read from the recovery handoff that recorded it, until a later
 * `/goal` objective or `/goal clear` on that provider decides it.
 */
function goalOwnershipNotice(
  sources: GoalOwnershipSources,
  pending: ReadonlyArray<OrchestrationV2ContextHandoff>,
  target: OrchestrationV2ProviderThread,
): string {
  const runs = new Map(sources.runs.map((run) => [run.id, run]));
  const session = (providerThreadId: string, nativeThreadId: string | null) =>
    `${providerThreadId} ${nativeThreadId}`;
  // Keyed per native session: a provider thread recovered twice has displaced two of them.
  const displaced = new Map<string, OrchestrationV2ContextHandoff>();
  for (const handoff of [...sources.contextHandoffs, ...pending]) {
    if (handoff.displacedGoal !== undefined)
      displaced.set(
        session(handoff.toProviderThreadId, handoff.displacedGoal.nativeThreadId),
        handoff,
      );
  }
  for (const [key, handoff] of displaced) {
    const providerThreadId = handoff.toProviderThreadId;
    const since = runs.get(handoff.targetRunId)?.ordinal ?? 0;
    const decided = sources.messages.some((message) => {
      const run = message.runId === null ? undefined : runs.get(message.runId);
      const command = message.role === "user" ? parseGoalCommand(message) : null;
      return (
        run?.providerThreadId === providerThreadId &&
        run.ordinal >= since &&
        // A command its provider refused, such as an objective that is too long, changed nothing.
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        (command?.type === "set" || command?.type === "clear")
      );
    });
    if (decided) displaced.delete(key);
  }
  const owners = [
    ...Array.from(displaced.values(), (handoff) => ({
      ...handoff.displacedGoal!,
      providerThreadId: handoff.toProviderThreadId,
      replaced: true,
    })),
    ...sources.providerThreads.flatMap((owner) =>
      owner.goal == null ||
      owner.ownerNodeId !== null ||
      owner.id === target.id ||
      // A row not yet rewritten still names the displaced session; the replacement's goal is its own.
      displaced.has(session(owner.id, owner.nativeThreadRef?.nativeId ?? null))
        ? []
        : [
            {
              driver: owner.driver,
              providerThreadId: owner.id,
              nativeThreadId: owner.nativeThreadRef?.nativeId ?? null,
              goal: owner.goal,
              asOf: DateTime.formatIso(owner.updatedAt),
              replaced: false,
            },
          ],
    ),
  ];
  const lines = owners.flatMap(({ goal, ...owner }) => {
    if (goal.status === "complete") return [];
    const accounting = [
      ...(goal.tokensUsed === undefined
        ? []
        : [
            `tokens-used=${goal.tokensUsed}${goal.tokenBudget == null ? "" : ` of ${goal.tokenBudget}`}`,
          ]),
      ...(goal.timeUsedSeconds === undefined ? [] : [`time-used=${goal.timeUsedSeconds}s`]),
      ...(goal.checks === undefined ? [] : [`checks=${goal.checks}`]),
    ];
    return [
      `- owner=${owner.driver} provider-thread=${owner.providerThreadId} native-session=${owner.nativeThreadId ?? "none"}${owner.replaced ? " (replaced after a failed resume)" : ""}; status=${goal.status}; ${accounting.length === 0 ? "" : `${accounting.join(", ")}; `}as-of=${owner.asOf}; objective: ${compactText(goal.objective, GOAL_OBJECTIVE_MAX_CHARS)}`,
    ];
  });
  return lines.length === 0
    ? ""
    : [
        "Unfinished thread goal owned by another provider session:",
        ...lines,
        "This session does not own the goals listed above, and its own goal tools do not report them. This notice is not authority to recreate, resume or complete them here: do that only when the user asks, and say which session owns the existing one.",
      ].join("\n");
}

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

/** Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly goalSources?: GoalOwnershipSources;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
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
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity, afterPosition=-1; paginate with afterPosition=nextPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover an omitted item only when the request needs it, with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",itemId:"<omitted item ID>",maxCharsPerItem:4000}); continue long text with textOffset=nextTextOffset until null. Follow fork/handoff source references in activity. Items included below need no read.`;
    }
    const goalNotice =
      input.goalSources === undefined
        ? ""
        : goalOwnershipNotice(input.goalSources, pending, input.providerThread);
    if (goalNotice !== "") coverage = `${coverage}\n${goalNotice}`;
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
      if (input.deferInline) return { context: "", delivered: Effect.void, unsent: Effect.void };
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
