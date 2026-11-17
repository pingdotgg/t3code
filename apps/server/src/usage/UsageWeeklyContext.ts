/**
 * What UsageService needs from the rest of the server to estimate each thread's share of weekly
 * limits: each provider instance's weekly window, and which T3 thread a native session belongs to.
 * Optional in UsageService, so usage still reads without it.
 */
import type { ProviderInstanceId, ServerProviderUsageWindow, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export interface WeeklyThreadRef {
  readonly threadId: ThreadId;
  readonly title: string;
}

export class UsageWeeklyContext extends Context.Service<
  UsageWeeklyContext,
  {
    readonly weeklyWindows: Effect.Effect<
      ReadonlyMap<ProviderInstanceId, ServerProviderUsageWindow>
    >;
    /** Keyed `${driver}\0${nativeId}`, for provider threads updated since `sinceIso`. */
    readonly threadsBySession: (
      sinceIso: string,
    ) => Effect.Effect<ReadonlyMap<string, WeeklyThreadRef>>;
  }
>()("t3/usage/UsageWeeklyContext") {}

export const sessionKey = (driver: string, nativeId: string) => `${driver}\0${nativeId}`;

/** Claude's model-scoped weeklies (`seven_day_<model>`) sit on top of the account-wide one. */
function accountWeeklyWindow(
  windows: readonly ServerProviderUsageWindow[],
): ServerProviderUsageWindow | undefined {
  const weekly = windows.filter(
    (window) =>
      window.kind === "weekly" &&
      window.resetsAt !== undefined &&
      Number.isFinite(Date.parse(window.resetsAt)),
  );
  return weekly.find((window) => !window.id.startsWith("seven_day_")) ?? weekly[0];
}

export const layer = Layer.effect(
  UsageWeeklyContext,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const sql = yield* SqlClient.SqlClient;
    return UsageWeeklyContext.of({
      weeklyWindows: registry.getProviders.pipe(
        Effect.map((providers) => {
          const windows = new Map<ProviderInstanceId, ServerProviderUsageWindow>();
          for (const provider of providers) {
            const limits = provider.usageLimits;
            if (limits === undefined || limits.unavailable !== undefined) continue;
            const window = accountWeeklyWindow(limits.windows);
            if (window !== undefined) windows.set(provider.instanceId, window);
          }
          return windows;
        }),
      ),
      threadsBySession: Effect.fn("UsageWeeklyContext.threadsBySession")(
        function* (sinceIso: string) {
          const rows = yield* sql<{
            driver: string;
            nativeId: string;
            threadId: ThreadId;
            title: string;
          }>`
            SELECT
              pt.driver AS "driver",
              json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS "nativeId",
              t.thread_id AS "threadId",
              t.title AS "title"
            FROM orchestration_v2_projection_provider_threads pt
            JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
            WHERE pt.updated_at >= ${sinceIso}
              AND t.deleted_at IS NULL
              AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
          `;
          const threads = new Map<string, WeeklyThreadRef>();
          for (const row of rows) {
            const key = sessionKey(row.driver, row.nativeId);
            if (!threads.has(key)) threads.set(key, { threadId: row.threadId, title: row.title });
          }
          return threads;
        },
        // A failed lookup leaves every session unmapped rather than failing the usage read.
        Effect.orElseSucceed(() => new Map<string, WeeklyThreadRef>()),
      ),
    });
  }),
);
