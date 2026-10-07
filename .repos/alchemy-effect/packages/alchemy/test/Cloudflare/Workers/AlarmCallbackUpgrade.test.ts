import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import type {
  MigrationProbe,
  Snapshot,
} from "./fixtures/alarm-upgrade/types.ts";
import AlarmUpgradeWorker from "./fixtures/alarm-upgrade/v2.ts";

class WorkerVersionPending extends Error {}

const requestJson = Effect.fn(
  function* (
    url: string,
    action = "snapshot",
    workerVersion: Snapshot["version"] = "v2",
  ) {
    const fresh = yield* Effect.sync(() => {
      const fresh = new URL(`${url}/${action}`);
      fresh.searchParams.set("cb", String(Date.now()));
      return fresh;
    });
    const response = yield* requestWorker(
      (fresh.pathname === "/snapshot"
        ? HttpClientRequest.get(fresh.href)
        : HttpClientRequest.post(fresh.href)
      ).pipe(
        // A fresh connection avoids polling an edge still pinned to the old deployment.
        HttpClientRequest.setHeaders({
          connection: "close",
          "cache-control": "no-cache",
          "x-alarm-worker-version": workerVersion,
        }),
      ),
    ).pipe(Effect.timeout("15 seconds"));
    if (response.status !== 200) {
      const body = yield* response.text;
      const actualVersion = response.headers["x-alarm-worker-version"];
      if (
        response.status === 409 &&
        actualVersion === (workerVersion === "v1" ? "v2" : "v1") &&
        body === "Alarm worker version mismatch"
      ) {
        return yield* Effect.fail(
          new WorkerVersionPending(
            `Waiting for Worker ${workerVersion}; got ${actualVersion}`,
          ),
        );
      }
      return yield* Effect.fail(
        new Error(
          `Upgrade fixture ${action}: HTTP ${response.status}\n${body}`,
        ),
      );
    }
    const body: unknown = yield* response.json;
    return body;
  },
  Effect.retry({
    while: (error) => error instanceof WorkerVersionPending,
    schedule: Schedule.spaced("1 second"),
    times: 10,
  }),
);

const request = (
  url: string,
  action = "snapshot",
  workerVersion: Snapshot["version"] = "v2",
) =>
  requestJson(url, action, workerVersion).pipe(
    Effect.map((body) => body as Snapshot),
  );

const ready = (url: string, version: Snapshot["version"], name?: string) =>
  request(
    url,
    name === undefined
      ? "snapshot"
      : `snapshot?name=${encodeURIComponent(name)}`,
    version,
  ).pipe(
    Effect.flatMap((snapshot) =>
      snapshot.version === version
        ? Effect.succeed(snapshot)
        : Effect.fail(
            new Error(`Waiting for ${version}; got ${snapshot.version}`),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
  );

const delivered = (
  url: string,
  until: (snapshot: Snapshot) => boolean,
  workerVersion: Snapshot["version"] = "v2",
) =>
  request(url, "snapshot", workerVersion).pipe(
    Effect.repeat({ schedule: Schedule.spaced("1 second"), times: 10, until }),
    Effect.tap((snapshot) =>
      Effect.sync(() => expect(until(snapshot)).toBe(true)),
    ),
  );

const count = (
  snapshot: Snapshot,
  channel: "legacy" | "callback",
  id: string,
) =>
  snapshot.deliveries.filter(
    (delivery) => delivery.channel === channel && delivery.id === id,
  ).length;

for (const dev of [true, false]) {
  describe(
    dev ? "local alarm upgrade" : "live alarm upgrade",
    { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
    () => {
      const { test } = Test.make({ providers: Cloudflare.providers(), dev });

      test.provider(
        `${dev ? "local" : "live"} V1 to V2 deployment preserves legacy schema, jobs and object identity`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const main = yield* Effect.sync(
              () =>
                new URL("./fixtures/alarm-upgrade/v1.ts", import.meta.url)
                  .pathname,
            );
            const originalDeployment = yield* stack.deploy(
              Effect.gen(function* () {
                const host = yield* Cloudflare.Worker("AlarmUpgradeWorker", {
                  main,
                  env: {
                    UpgradeObject: Cloudflare.DurableObject("UpgradeObject"),
                  },
                });
                const reader = dev
                  ? undefined
                  : yield* Cloudflare.Worker("AlarmUpgradeV1Reader", {
                      main,
                      env: {
                        UpgradeObject: Cloudflare.DurableObject(
                          "UpgradeObject",
                          {
                            scriptName: host.workerName,
                          },
                        ),
                      },
                    });
                return { host, reader };
              }),
            );
            const original = originalDeployment.host;
            expect(original.url).toBeDefined();
            expect(
              original.durableObjectNamespaces.UpgradeObject,
            ).toBeDefined();
            if (dev) {
              expect(original.url).toMatch(/^http:\/\/localhost:\d+$/);
            } else {
              expect(original.url).toMatch(/^https:\/\//);
            }
            const initial = yield* ready(original.url!, "v1");
            expect(initial.marker).toBeNull();
            yield* request(original.url!, "seed", "v1");
            yield* ready(original.url!, "v1", "future-version");
            const futureOriginal = yield* request(
              original.url!,
              "seed?name=future-version",
              "v1",
            );
            yield* ready(original.url!, "v1", "atomic-migration");
            const rollbackOriginal = yield* request(
              original.url!,
              "seed?name=atomic-migration",
              "v1",
            );
            for (const seeded of [futureOriginal, rollbackOriginal]) {
              expect(seeded.tables).toEqual(["alchemy_scheduled_events"]);
              expect(seeded.schemaVersion).toBeNull();
              expect(seeded.schemaRows).toEqual([]);
              expect(seeded.legacyRows).toHaveLength(3);
            }
            const before = yield* delivered(
              original.url!,
              (snapshot) =>
                count(snapshot, "legacy", "v1-proof") === 1 &&
                snapshot.legacyRows.length === 3 &&
                snapshot.alarm ===
                  Math.min(...snapshot.legacyRows.map((row) => row.run_at)),
              "v1",
            );
            expect(before.version).toBe("v1");
            expect(before.marker).toBe("written-by-v1");
            expect(before.tables).toEqual(["alchemy_scheduled_events"]);
            expect(before.schemaVersion).toBeNull();
            expect(before.schemaRows).toEqual([]);
            expect(before.legacyRows.map((row) => row.id)).toEqual([
              "legacy-cancel",
              "legacy-one",
              "legacy-repeat",
            ]);
            expect(before.legacyColumns).toEqual([
              { name: "id", type: "TEXT", notnull: 0, pk: 1 },
              { name: "run_at", type: "INTEGER", notnull: 1, pk: 0 },
              { name: "repeat_ms", type: "INTEGER", notnull: 0, pk: 0 },
              { name: "payload", type: "TEXT", notnull: 1, pk: 0 },
            ]);
            expect(before.alarm).toBe(
              Math.min(...before.legacyRows.map((row) => row.run_at)),
            );
            expect(before.deliveries).toEqual([
              {
                version: "v1",
                channel: "legacy",
                id: "v1-proof",
                payload: { callback: "archive", value: "v1-proof" },
              },
            ]);

            // This is an update of the existing resource, not a fresh namespace or a schema-only fixture.
            const upgradedDeployment = yield* stack.deploy(
              Effect.gen(function* () {
                const host = yield* AlarmUpgradeWorker;
                const reader = dev
                  ? undefined
                  : yield* Cloudflare.Worker("AlarmUpgradeV1Reader", {
                      main,
                      env: {
                        UpgradeObject: Cloudflare.DurableObject(
                          "UpgradeObject",
                          {
                            scriptName: host.workerName,
                          },
                        ),
                      },
                    });
                return { host, reader };
              }),
            );
            const upgraded = upgradedDeployment.host;
            expect(upgraded.workerName).toBe(original.workerName);
            expect(upgraded.workerId).toBe(original.workerId);
            expect(upgraded.durableObjectNamespaces.UpgradeObject).toBe(
              original.durableObjectNamespaces.UpgradeObject,
            );
            const after = yield* ready(upgraded.url!, "v2");
            expect(after.id).toBe(before.id);
            expect(after.marker).toBe(before.marker);
            expect(after.constructors).toContain("v1");
            expect(after.constructors).toContain("v2");
            expect(after.legacyColumns).toEqual(before.legacyColumns);
            expect(after.legacyRows).toEqual(before.legacyRows);
            expect(after.deliveries).toEqual(before.deliveries);
            expect(after.alarm).toBe(before.alarm);
            expect(after.tables).toContain("alchemy_scheduled_events");
            expect(after.tables).toContain("alchemy_alarm_callbacks");
            expect(after.tables).toContain("alchemy_alarm_schema");
            expect(after.schemaVersion).toBe(1);
            expect(after.schemaRows).toEqual([{ id: 1, version: 1 }]);
            expect(after.callbacks).toEqual([]);
            if (upgradedDeployment.reader) {
              // Local restarts are atomic; live edges can still run V1 against the V2 object.
              const viaV1 = yield* request(
                upgradedDeployment.reader.url!,
                "snapshot",
                "v1",
              );
              expect(viaV1).toEqual(after);
              const rejected = yield* requestWorker(
                HttpClientRequest.post(
                  `${upgradedDeployment.reader.url!}/callback-first`,
                ).pipe(
                  HttpClientRequest.setHeader("x-alarm-worker-version", "v2"),
                ),
              );
              expect(rejected.status).toBe(409);
              expect(rejected.headers["x-alarm-worker-version"]).toBe("v1");
              expect(yield* rejected.text).toBe(
                "Alarm worker version mismatch",
              );
              expect(yield* request(upgraded.url!)).toEqual(after);
            }

            const callbackFirst = yield* request(
              upgraded.url!,
              "callback-first",
            );
            expect(callbackFirst.callbacks).toHaveLength(1);
            expect(callbackFirst.alarm).toBe(callbackFirst.callbacks[0].run_at);
            expect(callbackFirst.alarm!).toBeLessThan(before.alarm!);
            const reset = (yield* requestJson(
              upgraded.url!,
              "reconstruct",
            )) as {
              aborted: boolean;
            };
            expect(reset.aborted).toBe(true);
            const reconstructed = yield* ready(upgraded.url!, "v2");
            expect(reconstructed.constructors.length).toBeGreaterThan(
              callbackFirst.constructors.length,
            );
            expect(reconstructed.id).toBe(before.id);
            expect(reconstructed.marker).toBe(before.marker);
            expect(reconstructed.schemaVersion).toBe(1);
            expect(reconstructed.schemaRows).toEqual([{ id: 1, version: 1 }]);
            expect(reconstructed.schema).toEqual(callbackFirst.schema);
            expect(reconstructed.legacyRows).toEqual(callbackFirst.legacyRows);
            expect(reconstructed.callbacks).toEqual(callbackFirst.callbacks);
            expect(reconstructed.alarm).toBe(callbackFirst.alarm);
            const repeated = yield* request(upgraded.url!);
            expect(repeated.schemaVersion).toBe(1);
            expect(repeated.schemaRows).toEqual(reconstructed.schemaRows);
            expect(repeated.schema).toEqual(reconstructed.schema);
            expect(repeated.legacyRows).toEqual(reconstructed.legacyRows);
            expect(repeated.callbacks).toEqual(reconstructed.callbacks);
            expect(repeated.alarm).toBe(reconstructed.alarm);
            const legacyCanceled = yield* request(
              upgraded.url!,
              "cancel-legacy",
            );
            expect(legacyCanceled.legacyRows.map((row) => row.id)).toEqual([
              "legacy-one",
              "legacy-repeat",
            ]);
            expect(legacyCanceled.callbacks).toEqual(callbackFirst.callbacks);
            expect(legacyCanceled.alarm).toBe(callbackFirst.alarm);
            const callbackCanceled = yield* request(
              upgraded.url!,
              "cancel-callback",
            );
            expect(callbackCanceled.callbacks).toEqual([]);
            expect(callbackCanceled.legacyRows).toEqual(
              legacyCanceled.legacyRows,
            );
            expect(callbackCanceled.alarm).toBe(before.alarm);

            // Pending jobs start five minutes ahead so deployment latency cannot consume them in V1.
            // Moving only their due times forward keeps the native-alarm assertion bounded.
            const released = yield* request(upgraded.url!, "release");
            expect(released.callbacks).toHaveLength(1);
            expect(released.alarm).toBe(released.callbacks[0].run_at);
            for (const row of released.legacyRows) {
              const old = before.legacyRows.find(
                (event) => event.id === row.id,
              )!;
              expect(row.payload).toBe(old.payload);
              expect(row.repeat_ms).toBe(old.repeat_ms);
              expect(row.run_at).toBe(released.callbacks[0].run_at);
            }
            const fired = yield* delivered(
              upgraded.url!,
              (snapshot) =>
                count(snapshot, "legacy", "legacy-one") === 1 &&
                count(snapshot, "legacy", "legacy-repeat") >= 2 &&
                count(snapshot, "callback", "new-callback") === 1 &&
                snapshot.callbacks.length === 0 &&
                snapshot.legacyRows.length === 1 &&
                snapshot.alarm === snapshot.legacyRows[0].run_at,
            );
            expect(fired.legacyRows).toHaveLength(1);
            expect(fired.legacyRows[0].id).toBe("legacy-repeat");
            expect(fired.legacyRows[0].repeat_ms).toBe(2_000);
            expect(fired.legacyRows[0].run_at).toBeGreaterThan(
              released.legacyRows.find((row) => row.id === "legacy-repeat")!
                .run_at,
            );
            expect(fired.callbacks).toEqual([]);
            expect(fired.alarm).toBe(fired.legacyRows[0].run_at);
            for (const delivery of fired.deliveries.filter(
              (event) => event.id !== "v1-proof",
            )) {
              expect(delivery.version).toBe("v2");
              if (delivery.channel === "legacy") {
                expect(delivery.payload).toEqual({
                  callback: "archive",
                  value: delivery.id,
                });
              }
            }
            expect(count(fired, "legacy", "legacy-cancel")).toBe(0);
            expect(
              fired.deliveries.filter((event) => event.channel === "callback"),
            ).toEqual([
              {
                version: "v2",
                channel: "callback",
                id: "new-callback",
                payload: { value: "new-callback" },
              },
            ]);

            const onlyCallback = yield* request(upgraded.url!, "only-callback");
            expect(onlyCallback.legacyRows).toEqual([]);
            expect(onlyCallback.callbacks).toHaveLength(1);
            expect(onlyCallback.alarm).toBe(onlyCallback.callbacks[0].run_at);
            const callbackSurvived = yield* delivered(
              upgraded.url!,
              (snapshot) =>
                count(snapshot, "callback", "callback-survivor") === 1 &&
                snapshot.callbacks.length === 0 &&
                snapshot.alarm === null,
            );
            expect(callbackSurvived.callbacks).toEqual([]);
            expect(callbackSurvived.alarm).toBeNull();

            const onlyLegacy = yield* request(upgraded.url!, "only-legacy");
            expect(onlyLegacy.callbacks).toEqual([]);
            expect(onlyLegacy.legacyRows).toHaveLength(1);
            expect(onlyLegacy.alarm).toBe(onlyLegacy.legacyRows[0].run_at);
            const legacySurvived = yield* delivered(
              upgraded.url!,
              (snapshot) =>
                count(snapshot, "legacy", "legacy-survivor") === 1 &&
                snapshot.legacyRows.length === 0 &&
                snapshot.alarm === null,
            );
            expect(count(legacySurvived, "callback", "must-not-fire")).toBe(0);
            expect(count(legacySurvived, "callback", "canceled-callback")).toBe(
              0,
            );
            expect(count(legacySurvived, "legacy", "legacy-cancel")).toBe(0);
            expect(legacySurvived.legacyRows).toEqual([]);
            expect(legacySurvived.callbacks).toEqual([]);
            expect(legacySurvived.alarm).toBeNull();
            expect(legacySurvived.id).toBe(before.id);
            expect(legacySurvived.marker).toBe("written-by-v1");

            const future = (yield* requestJson(
              upgraded.url!,
              "migration-future?name=future-version",
            )) as MigrationProbe;
            expect(future.before.id).toBe(futureOriginal.id);
            expect(future.before.legacyRows).toEqual(futureOriginal.legacyRows);
            expect(future.before.schemaVersion).toBe(2);
            expect(future.before.schemaRows).toEqual([{ id: 1, version: 2 }]);
            expect(future.before.callbacks).toHaveLength(1);
            expect(future.before.alarm).toBe(futureOriginal.alarm);
            expect(future.failure?.tag).toBe("UnsupportedAlarmSchemaVersion");
            expect(future.failure?.version).toBe(2);
            expect(future.failure?.supportedVersion).toBe(1);
            expect(future.after).toEqual(future.before);
            expect(future.recovered).toBeNull();

            const rollback = (yield* requestJson(
              upgraded.url!,
              "migration-rollback?name=atomic-migration",
            )) as MigrationProbe;
            expect(rollback.before.id).toBe(rollbackOriginal.id);
            expect(rollback.before.legacyRows).toEqual(
              rollbackOriginal.legacyRows,
            );
            expect(rollback.before.schemaVersion).toBeNull();
            expect(rollback.before.schemaRows).toEqual([]);
            expect(rollback.before.tables).not.toContain(
              "alchemy_alarm_callbacks",
            );
            expect(rollback.before.tables).not.toContain(
              "alchemy_alarm_schema",
            );
            expect(
              rollback.before.schema.some(
                (row) => row.name === "idx_alchemy_scheduled_events_run_at",
              ),
            ).toBe(false);
            expect(rollback.failure).not.toBeNull();
            expect(rollback.failure!.message).toContain(
              "idx_alchemy_alarm_callbacks_run_at",
            );
            expect(rollback.after).toEqual(rollback.before);
            expect(rollback.after.alarm).toBe(rollbackOriginal.alarm);
            expect(rollback.retryBefore?.schemaVersion).toBe(0);
            expect(rollback.retryBefore?.schemaRows).toEqual([
              { id: 1, version: 0 },
            ]);
            expect(rollback.retryBefore?.legacyRows).toEqual(
              rollbackOriginal.legacyRows,
            );
            expect(rollback.recovered?.schemaVersion).toBe(1);
            expect(rollback.recovered?.schemaRows).toEqual([
              { id: 1, version: 1 },
            ]);
            expect(rollback.recovered?.legacyRows).toEqual(
              rollbackOriginal.legacyRows,
            );
            expect(rollback.recovered?.callbacks).toEqual([]);
            expect(rollback.recovered?.tables).toContain(
              "alchemy_alarm_callbacks",
            );
            expect(
              rollback.recovered?.schema.some(
                (row) =>
                  row.name === "idx_alchemy_scheduled_events_run_at" &&
                  row.type === "index",
              ),
            ).toBe(true);
            expect(rollback.recovered?.alarm).toBe(rollbackOriginal.alarm);
            yield* stack.destroy();
          }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 120_000 },
      );
    },
  );
}
