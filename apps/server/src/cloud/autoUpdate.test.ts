import { ServerSelfUpdateError, type ServerSelfUpdateInput } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CliUpdateError } from "../cli/update.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { autoUpdateCheck, autoUpdateSetting, autoUpdateTarget } from "./autoUpdate.ts";
import { ServerSelfUpdate } from "./selfUpdate.ts";

const outcome = (status: "committed" | "rolled-back" | "failed", targetVersion: string) => ({
  id: "update-1",
  fromVersion: "0.1.10",
  targetVersion,
  status,
});

it.each([
  ["a newer release", "0.1.11", undefined, "0.1.11"],
  ["the running release", "0.1.10", undefined, undefined],
  ["an older release", "0.1.9", undefined, undefined],
  ["a release whose trial rolled back", "0.1.11", outcome("rolled-back", "0.1.11"), undefined],
  ["a release whose trial failed", "0.1.11", outcome("failed", "0.1.11"), undefined],
  [
    "a release newer than one that rolled back",
    "0.1.12",
    outcome("rolled-back", "0.1.11"),
    "0.1.12",
  ],
] as const)("moves to %s only when it can", (_, newest, lastOutcome, expected) => {
  expect(autoUpdateTarget({ current: "0.1.10", newest, lastOutcome })).toBe(expected);
});

it.effect.each([
  ["unset in a standalone build", { T3CODE_STANDALONE: "1" }, true, false],
  ["unset in an upstream build", {}, false, false],
  [
    "disabled in a standalone build",
    { T3CODE_STANDALONE: "1", T3CODE_AUTO_UPDATE: "0" },
    false,
    true,
  ],
  ["disabled with false", { T3CODE_STANDALONE: "1", T3CODE_AUTO_UPDATE: "false" }, false, true],
  ["enabled in an upstream build", { T3CODE_AUTO_UPDATE: "1" }, true, true],
] as const)("automatic updates %s", ([_, env, enabled, explicit]) =>
  Effect.gen(function* () {
    expect(yield* autoUpdateSetting).toEqual({ enabled, explicit });
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
);

const runStatuses = [
  ["preparing", false],
  ["queued", false],
  ["starting", false],
  ["running", false],
  ["waiting", false],
  ["queued and held by the user", true],
  ["completed", true],
] as const;

const insertRun = (status: string, payload: object = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run-${status}`}, 'thread-1', 1, 'codex', ${status}, '2026-01-01T00:00:00.000Z',
        ${JSON.stringify(payload)})
    `;
  });

const selfUpdateStub = (
  onUpdate: (
    input: ServerSelfUpdateInput,
  ) => Effect.Effect<void, ServerSelfUpdateError, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const calls: Array<ServerSelfUpdateInput> = [];
    const context = yield* Effect.context<SqlClient.SqlClient>();
    const service = ServerSelfUpdate.of({
      update: (input) => {
        calls.push(input);
        return onUpdate(input).pipe(
          Effect.as({ targetVersion: input.targetVersion, method: "boot-service" as const }),
          Effect.provideContext(context),
        );
      },
      commitDesktopUpdate: () => Effect.die("unused"),
    });
    return { calls, service };
  });

// Far above the package version, so a version bump never makes this release current.
const check = (
  service: ServerSelfUpdate["Service"],
  newest: Effect.Effect<string, CliUpdateError> = Effect.succeed("999.0.0"),
) =>
  autoUpdateCheck({ newest, lastOutcome: undefined }).pipe(
    Effect.provideService(ServerSelfUpdate, service),
  );

describe("autoUpdateCheck", () => {
  it.effect.each(runStatuses)("with a %s run, updates only when idle", ([status, updates]) =>
    Effect.gen(function* () {
      yield* insertRun(
        status.startsWith("queued") ? "queued" : status,
        status === "queued and held by the user" ? { queueHeld: true } : {},
      );
      const { calls, service } = yield* selfUpdateStub(() => Effect.void);
      yield* check(service);
      expect(calls).toEqual(
        updates
          ? [{ targetVersion: "999.0.0", stageOnly: true }, { targetVersion: "999.0.0" }]
          : [],
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("stages but does not restart when a run starts during the download", () =>
    Effect.gen(function* () {
      const { calls, service } = yield* selfUpdateStub((input) =>
        input.stageOnly === true ? insertRun("running").pipe(Effect.orDie) : Effect.void,
      );
      yield* check(service);
      expect(calls).toEqual([{ targetVersion: "999.0.0", stageOnly: true }]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("a failed release lookup or download does not fail the scheduled check", () =>
    Effect.gen(function* () {
      const { calls, service } = yield* selfUpdateStub(() =>
        Effect.fail(new ServerSelfUpdateError({ reason: "Could not prepare t3@999.0.0." })),
      );
      yield* check(
        service,
        Effect.fail(new CliUpdateError({ reason: "Could not list t3 releases." })),
      );
      yield* check(service);
      expect(calls).toEqual([{ targetVersion: "999.0.0", stageOnly: true }]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});
