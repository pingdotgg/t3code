import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2GetThreadInsightsResult,
  type OrchestrationV2ThreadInsightsRow,
  type OrchestrationV2ProviderTurn,
  type ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import { combinedStatus, sumOf } from "@t3tools/shared/turnTokenUsage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as UsageService from "../usage/UsageService.ts";
import type { PricedRecord } from "../usage/usagePricing.ts";

const MAX_THREADS = 200;
const MAX_TURNS = 20_000;

export class ThreadInsightsQuery extends Context.Service<
  ThreadInsightsQuery,
  {
    readonly read: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      OrchestrationV2GetThreadInsightsResult,
      OrchestrationV2GetThreadProjectionError
    >;
  }
>()("t3/orchestration-v2/ThreadInsightsQuery") {}

const make = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const pricing = yield* UsageService.UsageService;
  const read = Effect.fn("ThreadInsightsQuery.read")(
    function* (input: { readonly threadId: ThreadId }) {
      const rows: OrchestrationV2ThreadInsightsRow[] = [];
      const remotes: OrchestrationV2GetThreadInsightsResult["remotes"][number][] = [];
      const unavailableThreadIds: ThreadId[] = [];
      const queue = [
        {
          threadId: input.threadId,
          parentThreadId: null as ThreadId | null,
          status: null as string | null,
        },
      ];
      const queued = new Set<ThreadId>([input.threadId]);
      const remoteKeys = new Set<string>();
      const turns = new Map<string, { turn: OrchestrationV2ProviderTurn; owner: ThreadId }>();
      const childOwners = new Map<string, ThreadId>();
      let truncated = false;
      let remainingTurns = MAX_TURNS;
      const readTurns = Effect.fn("ThreadInsightsQuery.readTurns")(function* (
        threadId: ThreadId,
        providerThreadIds?: readonly ProviderThreadId[],
      ) {
        const result = yield* store.getThreadProviderTurns(threadId, {
          limit: remainingTurns,
          ...(providerThreadIds === undefined ? {} : { providerThreadIds }),
        });
        remainingTurns -= result.providerTurns.length;
        truncated ||= result.truncated;
        return result.providerTurns;
      });
      for (let index = 0; index < queue.length; index++) {
        const target = queue[index]!;
        const snapshot = yield* store
          .getThreadRecords(target.threadId, ["runs", "subagents", "providerThreads"], {
            runStatuses: [],
            includeLatestRun: true,
          })
          .pipe(
            Effect.catch((cause) =>
              target.threadId === input.threadId ? Effect.fail(cause) : Effect.succeed(null),
            ),
          );
        if (snapshot === null) {
          unavailableThreadIds.push(target.threadId);
          continue;
        }
        const ownTurns = yield* readTurns(target.threadId).pipe(
          Effect.catch((cause) => {
            if (target.threadId === input.threadId) return Effect.fail(cause);
            unavailableThreadIds.push(target.threadId);
            return Effect.succeed([]);
          }),
        );
        const plan = yield* store.getLatestTodoList(target.threadId);
        const latestRun = snapshot.runs.reduce<(typeof snapshot.runs)[number] | null>(
          (held, run) => (held === null || run.ordinal > held.ordinal ? run : held),
          null,
        );
        rows.push({
          threadId: target.threadId,
          parentThreadId: target.parentThreadId,
          title: snapshot.thread.title,
          status: target.status ?? latestRun?.status ?? "idle",
          providerInstanceIds: [
            ...new Set(snapshot.providerThreads.map((thread) => thread.providerInstanceId)),
          ],
          steps: plan?.kind === "todo_list" ? plan.steps : null,
          usage: {
            status: "unavailable",
            turns: 0,
            measuredTurns: 0,
            costUsd: null,
            unpricedTurns: 0,
            hasOtherUsage: false,
          },
        });
        for (const agent of snapshot.subagents) {
          if (agent.remoteChild !== undefined) {
            const remote = agent.remoteChild;
            const key = `${remote.environmentId.length}:${remote.environmentId}${remote.threadId}`;
            if (remoteKeys.has(key)) continue;
            if (queue.length + remotes.length >= MAX_THREADS) {
              truncated = true;
              continue;
            }
            remoteKeys.add(key);
            remotes.push({
              environmentId: remote.environmentId,
              threadId: remote.threadId,
              parentThreadId: target.threadId,
              title: remote.title ?? agent.title ?? "Subagent",
              status: agent.status,
            });
          } else if (agent.childThreadId !== null) {
            if (agent.providerThreadId !== null)
              childOwners.set(agent.providerThreadId, agent.childThreadId);
            if (queued.has(agent.childThreadId)) continue;
            if (queue.length + remotes.length >= MAX_THREADS) {
              truncated = true;
              continue;
            }
            queued.add(agent.childThreadId);
            queue.push({
              threadId: agent.childThreadId,
              parentThreadId: target.threadId,
              status: agent.status,
            });
          }
        }
        // Some adapters keep native-child turns on the parent projection. Opening the
        // child directly must still find those turns without charging the parent's own work.
        let inheritedNativeTurns: readonly OrchestrationV2ProviderTurn[] = [];
        if (
          target.threadId === input.threadId &&
          snapshot.thread.lineage.relationshipToParent === "subagent" &&
          snapshot.thread.lineage.parentThreadId !== null
        ) {
          const parentId = snapshot.thread.lineage.parentThreadId;
          const parent = yield* store
            .getThreadRecords(parentId, ["subagents"])
            .pipe(Effect.orElseSucceed(() => null));
          if (parent === null) unavailableThreadIds.push(target.threadId);
          const nativeOwner = parent?.subagents.find(
            (agent) =>
              agent.childThreadId === target.threadId && agent.origin === "provider_native",
          );
          if (nativeOwner?.providerThreadId != null) {
            const recorded = yield* readTurns(parentId, [nativeOwner.providerThreadId]).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (recorded === null) unavailableThreadIds.push(target.threadId);
            else inheritedNativeTurns = recorded;
          }
        }
        for (const turn of [...ownTurns, ...inheritedNativeTurns]) {
          const held = turns.get(turn.id);
          // Copies are routed between parent and child projections. Prefer the final counters.
          const rank = (value: OrchestrationV2ProviderTurn) =>
            value.turnTokenUsage?.usageStatus === "complete"
              ? 2
              : value.turnTokenUsage === undefined
                ? 0
                : 1;
          if (held === undefined || rank(turn) > rank(held.turn))
            turns.set(turn.id, { turn, owner: target.threadId });
        }
      }
      const rowsById = new Map(rows.map((row) => [row.threadId, row]));
      const owned = new Map<ThreadId, OrchestrationV2ProviderTurn[]>();
      for (const entry of turns.values()) {
        const child = childOwners.get(entry.turn.providerThreadId);
        const owner = child !== undefined && rowsById.has(child) ? child : entry.owner;
        const list = owned.get(owner) ?? [];
        list.push(entry.turn);
        owned.set(owner, list);
      }
      const priced: PricedRecord[] = [];
      const priceIds: string[] = [];
      for (const { turn } of turns.values()) {
        const usage = turn.turnTokenUsage;
        if (usage?.usageStatus !== "complete" || usage.models?.length !== 1) continue;
        priceIds.push(turn.id);
        priced.push({
          model: usage.models[0]!,
          totals: {
            uncachedInputTokens: Math.max(
              0,
              usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheCreationTokens ?? 0),
            ),
            cachedInputTokens: usage.cachedInputTokens ?? 0,
            cacheCreationTokens: usage.cacheCreationTokens ?? 0,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens ?? 0,
          },
          reportedCostUsd: null,
          speed: "standard",
        });
      }
      const costs = yield* pricing.priceTurnRecords(priced);
      const byTurn = new Map(priceIds.map((id, index) => [id, costs[index] ?? null]));
      const resultRows = rows.map((row) => {
        const rowTurns = owned.get(row.threadId) ?? [];
        const usages = rowTurns.map((turn) => turn.turnTokenUsage);
        const measured = usages.filter((usage) => usage !== undefined);
        const costValues = rowTurns.map((turn) => byTurn.get(turn.id) ?? null);
        const knownCosts = costValues.filter((cost) => cost !== null);
        const status = combinedStatus(usages);
        const usage = {
          status:
            unavailableThreadIds.includes(row.threadId) && status === "complete"
              ? ("partial" as const)
              : status,
          turns: rowTurns.length,
          measuredTurns: measured.filter((value) => value.usageStatus !== "unavailable").length,
          costUsd: knownCosts.length === 0 ? null : knownCosts.reduce((a, b) => a + b, 0),
          unpricedTurns: rowTurns.length - knownCosts.length,
          hasOtherUsage: measured.some(
            (value) =>
              (value.otherUsage?.inputTokens ?? 0) > 0 || (value.otherUsage?.outputTokens ?? 0) > 0,
          ),
        };
        const totals: {
          inputTokens?: number;
          cachedInputTokens?: number;
          cacheCreationTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
        } = {};
        for (const field of [
          "inputTokens",
          "cachedInputTokens",
          "cacheCreationTokens",
          "outputTokens",
          "reasoningTokens",
        ] as const) {
          const sum = sumOf(measured, field, false);
          if (sum !== undefined) totals[field] = sum;
        }
        return { ...row, usage: { ...usage, ...totals } };
      });
      return { rows: resultRows, remotes, unavailableThreadIds, truncated };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: "Failed to read thread tasks and usage.",
              cause,
            }),
        ),
      ),
  );
  return ThreadInsightsQuery.of({ read });
});
export const layer = Layer.effect(ThreadInsightsQuery, make);
