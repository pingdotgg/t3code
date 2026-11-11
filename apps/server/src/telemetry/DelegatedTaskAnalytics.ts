/**
 * Record one anonymous `mcp.delegated_task.finished` event per app-owned task reaching final status.
 *
 * @module DelegatedTaskAnalytics
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { crossProvider, providerDimensions } from "./ProviderDimensions.ts";

type SubagentEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "subagent.updated" }>;

const FINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  // A task can be re-reported with the same final status; count it once per process.
  const reported = new Set<string>();

  // Runs for every subagent update; most return early, so avoid a span per event.
  const onSubagent = Effect.fnUntraced(
    function* (event: SubagentEvent) {
      const task = event.payload;
      if (task.origin !== "app_owned" || !FINAL_STATUSES.has(task.status)) return;
      if (reported.has(task.id)) return;
      const parent = yield* orchestrator.getThreadShell(task.threadId);
      const providers = yield* registry.getProviders;
      const parentDimensions =
        parent === null
          ? { provider: "unknown" }
          : providerDimensions(providers, parent.modelSelection);
      const child = providerDimensions(providers, {
        instanceId: task.providerInstanceId,
        model: task.model ?? "",
      });
      const cross = crossProvider(parentDimensions.provider, child.provider);
      const durationSeconds =
        task.startedAt !== null && task.completedAt !== null
          ? Math.max(
              0,
              Math.round(
                (DateTime.toEpochMillis(task.completedAt) -
                  DateTime.toEpochMillis(task.startedAt)) /
                  1000,
              ),
            )
          : undefined;
      yield* analytics.record("mcp.delegated_task.finished", {
        status: task.status,
        callerProvider: parentDimensions.provider,
        ...(parentDimensions.model === undefined ? {} : { callerModel: parentDimensions.model }),
        targetProvider: child.provider,
        ...(child.model === undefined ? {} : { targetModel: child.model }),
        ...(cross === undefined ? {} : { crossProvider: cross }),
        ...(task.completionWake === undefined ? {} : { completionWake: task.completionWake }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
      // Only after recording: a failed lookup leaves the next final update to report it.
      reported.add(task.id);
    },
    (effect) => effect.pipe(Effect.ignoreCause),
  );

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "subagent.updated" ? onSubagent(event) : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(make);
