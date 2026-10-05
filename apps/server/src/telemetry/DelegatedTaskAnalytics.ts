/**
 * Records one anonymous `mcp.delegated_task.finished` event when an app-owned
 * delegated task reaches a final status, so we can see whether delegation
 * between providers actually completes. The event carries the parent and child
 * provider and model, the final status, and the child's runtime in seconds.
 *
 * @module DelegatedTaskAnalytics
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { providerDimensions } from "./ProviderDimensions.ts";

type SubagentEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "subagent.updated" }>;

const FINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  // A task can be re-reported with the same final status; count it once per process.
  const reported = new Set<string>();

  const onSubagent = (event: SubagentEvent) =>
    Effect.gen(function* () {
      const task = event.payload;
      if (task.origin !== "app_owned" || !FINAL_STATUSES.has(task.status)) return;
      if (reported.has(task.id)) return;
      reported.add(task.id);
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
        crossProvider: parentDimensions.provider !== child.provider,
        ...(task.completionWake === undefined ? {} : { completionWake: task.completionWake }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
    }).pipe(Effect.ignoreCause);

  const start = Effect.fn("DelegatedTaskAnalytics.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "subagent.updated" ? onSubagent(event) : Effect.void,
      ),
    );
  });

  return { start, onSubagent };
});
