import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { PullRequestMonitorCursor } from "./monitorDiff.ts";

export interface MonitorRegistration {
  readonly threadId: ThreadId;
  readonly prNumber: number;
  readonly generation: number;
  readonly cursor: PullRequestMonitorCursor;
  readonly wakeCount: number;
  readonly repoCwd: string;
}

export interface MonitorRegistryShape {
  /** Registers only when the thread has no active registration; returns
      whether this call won. Losing concurrent monitor_start calls must not
      clobber the winner's cursor/generation. */
  readonly registerIfAbsent: (registration: MonitorRegistration) => Effect.Effect<boolean>;
  /** Removes only the exact generation the caller installed, so a failed
      start can roll back without erasing a racing winner's registration. */
  readonly removeGeneration: (threadId: ThreadId, generation: number) => Effect.Effect<void>;
  readonly get: (threadId: ThreadId) => Effect.Effect<Option.Option<MonitorRegistration>>;
  readonly updateCursor: (
    threadId: ThreadId,
    cursor: PullRequestMonitorCursor,
  ) => Effect.Effect<void>;
  readonly incrementWake: (threadId: ThreadId) => Effect.Effect<number>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<Option.Option<MonitorRegistration>>;
  readonly listActive: Effect.Effect<ReadonlyArray<MonitorRegistration>>;
}

export class MonitorRegistry extends Context.Service<MonitorRegistry, MonitorRegistryShape>()(
  "t3/monitor/MonitorRegistry",
) {}

// Module-global store, mirroring McpProviderSession: the registry is
// constructed both in the runtime core (for the poller) and inside the MCP
// routes layer (for monitor_start), and those two layer instances must see
// the same registrations. All operations are synchronous, so plain-Map
// mutation inside Effect.sync is atomic per call.
const registrations = new Map<ThreadId, MonitorRegistration>();

const make: MonitorRegistryShape = {
  registerIfAbsent: (registration) =>
    Effect.sync(() => {
      if (registrations.has(registration.threadId)) return false;
      registrations.set(registration.threadId, registration);
      return true;
    }),
  removeGeneration: (threadId, generation) =>
    Effect.sync(() => {
      const current = registrations.get(threadId);
      if (current !== undefined && current.generation === generation) {
        registrations.delete(threadId);
      }
    }),
  get: (threadId) => Effect.sync(() => Option.fromNullishOr(registrations.get(threadId))),
  updateCursor: (threadId, cursor) =>
    Effect.sync(() => {
      const current = registrations.get(threadId);
      if (current !== undefined) registrations.set(threadId, { ...current, cursor });
    }),
  incrementWake: (threadId) =>
    Effect.sync(() => {
      const current = registrations.get(threadId);
      const wakeCount = (current?.wakeCount ?? 0) + 1;
      if (current !== undefined) registrations.set(threadId, { ...current, wakeCount });
      return wakeCount;
    }),
  remove: (threadId) =>
    Effect.sync(() => {
      const current = registrations.get(threadId);
      registrations.delete(threadId);
      return Option.fromNullishOr(current);
    }),
  listActive: Effect.sync(() => [...registrations.values()]),
};

// The engine used for teardown dispatch is bound by PullRequestMonitor when
// it starts (it is the only construction site that has the engine and runs in
// the runtime core). Until then teardown just clears the store.
let activeEngine: OrchestrationEngineService["Service"] | undefined;

export const bindEngine = (engine: OrchestrationEngineService["Service"]): void => {
  activeEngine = engine;
};

export const layer = Layer.effect(
  MonitorRegistry,
  Effect.acquireRelease(Effect.succeed(MonitorRegistry.of(make)), () =>
    Effect.gen(function* () {
      for (const registration of [...registrations.values()]) {
        yield* endActiveMonitorForSession(registration.threadId);
      }
    }),
  ),
);

export const endActiveMonitorForSession = (threadId: ThreadId): Effect.Effect<void> =>
  Effect.gen(function* () {
    const registration = yield* make.remove(threadId);
    if (Option.isNone(registration) || activeEngine === undefined) return;
    const endedAt = DateTime.formatIso(yield* DateTime.now);
    const commandId = CommandId.make(`monitor-session-ended:${threadId}:${endedAt}`);
    yield* activeEngine.dispatch({
      type: "thread.monitor.end",
      commandId,
      threadId,
      reason: "session-ended",
      blockersSummary: "",
      endedAt,
    });
  }).pipe(
    Effect.catch((error) => Effect.logWarning("monitor teardown failed", { threadId, error })),
  );

export const __testing = {
  make,
  reset: (): void => {
    registrations.clear();
    activeEngine = undefined;
  },
};
