import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Output from "@/Output";
import type { ScratchStack } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { randomBytes } from "node:crypto";
import { Ledger, ledgerLayer } from "./bluegreen-worker-ledger.ts";
import {
  Worker,
  workerLayer,
  type WorkerOptions,
} from "./bluegreen-worker-managed.ts";
import {
  Cache,
  LedgerSite,
  WorkerSite,
  services,
  type LedgerEvent,
  type Snapshot,
  scripts,
} from "./bluegreen-worker-shared.ts";

const readinessProbe = `
const report = (value) => console.log(value);
report(process.env.REDIS_URL ? "redis-url:present" : "redis-url:missing");
report(process.env.LEDGER_TOKEN ? "ledger-token:present" : "ledger-token:missing");
report(["1", "2"].includes(process.env.WORKERS) ? "workers:valid" : "workers:missing-or-invalid");
report(["0", "1"].includes(process.env.RUN_ONLY) ? "run-only:valid" : "run-only:missing-or-invalid");
try {
  const value = JSON.parse(process.env.WORKERS);
  report(typeof value === "number" ? "workers-decoded:number" : "workers-decoded:other");
} catch { report("workers-decoded:other"); }
for (const [family, host] of [["ipv4", "127.0.0.1"], ["ipv6", "[::1]"]]) {
  try {
    const response = await fetch("http://" + host + ":3000/health", {
      signal: AbortSignal.timeout(1500),
    });
    report(family + (response.status === 200 ? ":ready" : response.status === 503 ? ":starting" : ":other-status"));
    await response.body?.cancel();
  } catch { report(family + ":unreachable"); }
}
if (process.env.LEDGER_URL) {
  try {
    const response = await fetch(process.env.LEDGER_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.LEDGER_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ operation: "snapshot", args: [] }),
      signal: AbortSignal.timeout(1500),
    });
    report(response.status === 200 ? "ledger:authenticated" : response.status === 401 ? "ledger:unauthorized" : "ledger:other-status");
    await response.body?.cancel();
  } catch { report("ledger:unreachable"); }
}
`;

const readinessProbeLabels = new Set([
  "redis-url:present",
  "redis-url:missing",
  "ledger-token:present",
  "ledger-token:missing",
  "workers:valid",
  "workers:missing-or-invalid",
  "run-only:valid",
  "run-only:missing-or-invalid",
  "workers-decoded:number",
  "workers-decoded:other",
  "ipv4:ready",
  "ipv4:starting",
  "ipv4:other-status",
  "ipv4:unreachable",
  "ipv6:ready",
  "ipv6:starting",
  "ipv6:other-status",
  "ipv6:unreachable",
  "ledger:authenticated",
  "ledger:unauthorized",
  "ledger:other-status",
  "ledger:unreachable",
]);

const diagnoseMachines = (appName: string, role: "worker" | "ledger") =>
  Effect.gen(function* () {
    const live = yield* machines
      .listMachines({ app_name: appName })
      .pipe(Effect.timeout("8 seconds"));
    yield* Effect.logError("Worker readiness machine census", {
      role,
      appName,
      machines: live.map((machine) => ({
        id: machine.id,
        state: machine.state,
        checks: machine.checks?.map((check) => ({
          name: check.name,
          status: check.status,
        })),
      })),
    });
    for (const machine of live.slice(0, 2)) {
      const machineId = machine.id;
      if (!machineId || machine.state !== "started") continue;
      yield* machines
        .execMachine({
          app_name: appName,
          machine_id: machineId,
          command: ["node", "--input-type=module", "-e", readinessProbe],
          timeout: 6,
        })
        .pipe(
          Effect.timeout("8 seconds"),
          Effect.flatMap((response) =>
            Effect.logError("Worker readiness safe exec observations", {
              role,
              machineId,
              exitCode: response.exit_code,
              observations: (response.stdout ?? "")
                .split("\n")
                .filter((line) => readinessProbeLabels.has(line)),
            }),
          ),
          Effect.catchCause(() =>
            Effect.logWarning("Worker readiness exec unavailable", {
              role,
              machineId,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Worker readiness machine census unavailable", {
        role,
        appName,
      }),
    ),
  );

export const requireValue = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(new Error(`Missing ${name}`))
    : Effect.succeed(value);

export const makeScenario = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const token = yield* Effect.sync(() =>
      Array.from(randomBytes(32), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    const fs = yield* FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("./bluegreen-worker-raw.mjs", import.meta.url),
      ),
    );
    const deploy = (
      options: WorkerOptions & {
        raw?: boolean;
        rawSignal?: "SIGQUIT" | "SIGTERM";
        gatewayOnly?: boolean;
      },
    ) =>
      stack.deploy(
        Effect.gen(function* () {
          const cache = yield* Cache;
          const ledgerApp = yield* LedgerSite;
          const ledgerSecret = yield* Fly.Secret("LedgerToken", {
            app: ledgerApp,
            name: "LEDGER_TOKEN",
            value: Redacted.make(token),
          });
          yield* Fly.IpAssignment("LedgerIp", {
            app: ledgerApp,
            type: "shared_v4",
          });
          const ledger = yield* Ledger.pipe(
            Effect.provide(ledgerLayer(ledgerSecret.digest)),
          );
          const ledgerUrl = ledger.url.pipe(
            Output.mapEffect((url) =>
              url
                ? Effect.succeed(url)
                : Effect.die(new Error("Ledger service URL missing")),
            ),
          );
          const workerApp = yield* WorkerSite;
          const workerSecret = yield* Fly.Secret("WorkerToken", {
            app: workerApp,
            name: "LEDGER_TOKEN",
            value: Redacted.make(token),
          });
          if (!options.runOnly)
            yield* Fly.IpAssignment("WorkerIp", {
              app: workerApp,
              type: "shared_v4",
            });
          const worker = options.gatewayOnly
            ? undefined
            : options.raw
              ? yield* Fly.Machine("RawWorker", {
                  app: workerApp,
                  image: "node:26-slim",
                  region: "iad",
                  guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
                  init: { exec: ["node", "--input-type=module", "-e", raw] },
                  env: {
                    VERSION: options.version,
                    MODE: options.mode ?? "drain",
                    AFTER_SIGNAL_MS: String(options.afterSignalMs ?? 1000),
                    SHUTDOWN_MS: String(
                      options.timeout === "60 seconds"
                        ? 60000
                        : options.timeout === "10 seconds"
                          ? 10000
                          : 30000,
                    ),
                    LEDGER_URL: ledgerUrl,
                    SECRET_READY: workerSecret.digest.pipe(
                      Output.mapEffect((digest) =>
                        requireValue(digest, "worker secret digest").pipe(
                          Effect.orDie,
                        ),
                      ),
                    ),
                  },
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "45 seconds",
                  },
                  shutdown: {
                    signal: options.rawSignal ?? options.signal,
                    timeout: options.timeout,
                  },
                  services: options.runOnly ? [] : services,
                  checks: options.runOnly
                    ? {
                        ready: {
                          type: "http",
                          port: 3000,
                          path: "/health",
                          interval: "2s",
                          timeout: "1s",
                        },
                      }
                    : undefined,
                })
              : yield* Worker.pipe(Effect.provide(workerLayer(options)));
          return { cache, ledger, ledgerUrl, worker, workerApp, ledgerApp };
        }),
      );
    type Deployment = Effect.Success<ReturnType<typeof deploy>>;
    let inventory: Deployment | undefined;
    const trackedDeploy = (options: Parameters<typeof deploy>[0]) =>
      Effect.gen(function* () {
        if (inventory === undefined) {
          inventory = yield* deploy({ ...options, gatewayOnly: true });
          if (options.gatewayOnly) return inventory;
        }
        const value = yield* deploy(options);
        inventory = value;
        return value;
      }).pipe(
        Effect.tapCause(() => {
          const observed = inventory;
          if (!observed) return Effect.void;
          return Effect.all(
            [
              diagnoseMachines(observed.workerApp.appName, "worker"),
              diagnoseMachines(observed.ledgerApp.appName, "ledger"),
              snapshot(observed.ledgerUrl).pipe(
                Effect.flatMap((value) =>
                  Effect.logError(
                    "Worker lifecycle ledger at failure",
                    value.events.slice(-30),
                  ),
                ),
                Effect.catchCause(() =>
                  Effect.logWarning(
                    "Worker lifecycle ledger unavailable during failure diagnostics",
                  ),
                ),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
    const call = (
      url: string,
      operation: keyof typeof scripts,
      args: string[] = [],
      requestTimeout: "8 seconds" | "30 seconds" = "8 seconds",
    ) =>
      HttpClient.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          HttpClientRequest.bodyJsonUnsafe({ operation, args }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`ledger HTTP ${response.status}`)),
        ),
        Effect.map((body) => (body as { result: unknown }).result),
        Effect.timeout(requestTimeout),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new Error(`Ledger ${operation} request exceeded ${requestTimeout}`),
          ),
        ),
      );
    const snapshot = (url: string) =>
      // Durable observations have a separate budget from the worker's shutdown grace.
      call(url, "snapshot", [], "30 seconds").pipe(
        Effect.map((result) => {
          const value = JSON.parse(String(result)) as Snapshot;
          return {
            ...value,
            events: (Array.isArray(value.events) ? value.events : []).map(
              (event) => JSON.parse(event) as LedgerEvent,
            ),
            results: Array.isArray(value.results) ? value.results : [],
            checkpoints: Array.isArray(value.checkpoints)
              ? value.checkpoints
              : [],
            produced: Array.isArray(value.produced) ? value.produced : [],
          };
        }),
      );
    const wait = (
      url: string,
      predicate: (
        value: Effect.Success<ReturnType<typeof snapshot>>,
      ) => boolean,
    ) =>
      snapshot(url).pipe(
        Effect.repeat({
          until: predicate,
          times: 10,
          schedule: Schedule.spaced("1 second"),
        }),
        Effect.timeout("45 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new Error("Ledger predicate observation exceeded 45 seconds"),
          ),
        ),
        Effect.tap((value) =>
          Effect.sync(() => expect(predicate(value)).toBe(true)),
        ),
      );
    const settle = (url: string) =>
      Effect.gen(function* () {
        yield* call(url, "pause");
        const ledger = yield* wait(
          url,
          (value) =>
            value.pending === 0 &&
            value.results.length === value.produced.length * 2,
        );
        expect(ledger.entries).toBe(ledger.produced.length);
        const completed = ledger.results.filter(
          (_value, index) => index % 2 === 0,
        );
        expect([...completed].sort()).toEqual([...ledger.produced].sort());
        return ledger;
      });
    const cleanup = Effect.gen(function* () {
      yield* stack.destroy();
      if (!inventory) return;
      for (const appName of [
        inventory.workerApp.appName,
        inventory.ledgerApp.appName,
      ]) {
        const gone = yield* machines.getApp({ app_name: appName }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            until: (value) => value,
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        expect(gone).toBe(true);
      }
      expect(
        yield* Fly.findRedisAddOn({
          id: inventory.cache.redisId,
          name: inventory.cache.name,
        }),
      ).toBeUndefined();
    }).pipe(Effect.orDie);
    return { deploy: trackedDeploy, call, snapshot, wait, settle, cleanup };
  });

export const assertOrder = (
  events: LedgerEvent[],
  machine: string,
  first: string,
  second: string,
  worker?: string,
) => {
  const selected = events.filter(
    (event) =>
      event.machine === machine &&
      (worker === undefined || event.worker === worker),
  );
  expect(
    selected.findIndex((event) => event.event === first),
  ).toBeGreaterThanOrEqual(0);
  expect(selected.findIndex((event) => event.event === second)).toBeGreaterThan(
    selected.findIndex((event) => event.event === first),
  );
};
export const assertStopped = (events: LedgerEvent[], machine: string) => {
  const stopped = events.findLastIndex(
    (event) => event.machine === machine && event.event === "stopped",
  );
  expect(stopped).toBeGreaterThanOrEqual(0);
  expect(
    events
      .slice(stopped + 1)
      .filter(
        (event) =>
          event.machine === machine &&
          ["claimed", "reclaimed", "producer"].includes(event.event),
      ),
  ).toEqual([]);
};
export const assertReplacement = (
  appName: string,
  oldId: string,
  newId: string,
) =>
  Effect.gen(function* () {
    expect(newId).not.toBe(oldId);
    const live = (yield* machines.listMachines({ app_name: appName })).filter(
      (machine) => machine.state !== "destroyed",
    );
    expect(live.map((machine) => machine.id)).toEqual([newId]);
    expect(
      yield* machines.getMachine({ app_name: appName, machine_id: oldId }).pipe(
        Effect.map((machine) => machine.state === "destroyed"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      ),
    ).toBe(true);
  });
