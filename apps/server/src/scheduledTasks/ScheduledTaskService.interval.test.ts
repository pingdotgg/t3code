import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

afterEach(() => vi.unstubAllEnvs());

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () => Effect.die("synthetic dispatch failure"),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "interval-duration",
  title: "Interval review",
  prompt: "Review the open pull requests.",
  enabled: true,
  projectId: "project-interval-duration",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

it.effect.each([
  {
    zone: "America/New_York",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T05:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-11-01T07:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "UTC",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "Asia/Tokyo",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
] as const)("persists elapsed interval $zone from $from", ({ zone, from, everyMs, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", zone);
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({ ...input, schedule: { type: "interval", everyMs } });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);

      const paused = yield* service.setEnabled({ id: created.task.id, enabled: false });
      expect(paused.task.nextRunAt).toBeNull();
      const resumed = yield* service.setEnabled({ id: created.task.id, enabled: true });
      expect(resumed.task.nextRunAt).toBe(expected);

      // Exercise completion rescheduling without starting any provider process.
      const completed = yield* service.runNow({ id: created.task.id });
      expect(completed.task.lastRunStatus).toBe("failed");
      expect(completed.task.runCount).toBe(1);
      expect(completed.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    // Keep the real scheduler parked while exercising finite service actions.
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect.each([
  { from: "2026-03-07T23:30:00.000Z", expected: "2026-03-08T13:00:00.000Z" },
  { from: "2026-10-31T23:30:00.000Z", expected: "2026-11-01T14:00:00.000Z" },
] as const)("keeps fixed-time schedules on the local calendar from $from", ({ from, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "America/New_York");
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({
        ...input,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);
