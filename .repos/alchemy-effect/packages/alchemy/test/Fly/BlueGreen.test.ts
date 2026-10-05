import * as machines from "@distilled.cloud/fly-io/machines";
import { type Machine } from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import {
  waitHealthy,
  autostopMode,
  checksPassing,
  ensureStarted,
  observeReplicaSet,
  predecessorShutdown,
  deleteReplicaSet,
  ReplicaNotCreated,
  ReplicaRetirementIncomplete,
  retireMachines,
  retireMachine,
} from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect, assert, it, describe } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  census,
  checks,
  deployWorker,
  assertCommitted,
} from "./fixtures/bluegreen.ts";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import { DestroyError } from "@/Apply";
import { AppDeletionAmbiguous } from "@/Fly/App";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { engineActor } from "./fixtures/actors.ts";
import {
  transportProxy,
  throughProxy,
  type TransportEvent,
} from "./fixtures/transport.ts";
import { readinessRoles, DeploymentRecoveryAmbiguous } from "@/Fly/bluegreen";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as Exit from "effect/Exit";
import {
  makeReadinessControl,
  repairReadiness,
} from "./fixtures/http-readiness-control.ts";
import { makeMachineLeases } from "@/Fly/leases";
import * as Clock from "effect/Clock";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { sanitizeExecFailure } from "./fixtures/exec-lease.ts";
import { type MachineContainer, type MachineProps } from "@/Fly/Machine";
import { ReplicaChecksNotPassing } from "@/Fly/replicas";
import type { ScratchStack } from "@/Test/Alchemy";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import {
  assertReadinessCommit,
  readinessActor,
  readinessChecksPassing,
  readinessProxy,
  retires,
  type ReadinessEvent,
} from "./fixtures/idle-cadence-readiness.ts";
import * as Docker from "@/Docker";
import * as TestCore from "@/Test/Core";
import { scratchStack, withProviders } from "@/Test/Core";
import * as Redacted from "effect/Redacted";
import {
  GatewayTimeout,
  HTTP_STATUS_MAP,
  RETRYABLE_HTTP_STATUSES,
} from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/fly-io/Credentials";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { dropCompletedCreate } from "./fixtures/bluegreen-create-proxy.ts";
import {
  observeStops,
  type StopRequest,
  writeLegacyProtocol,
} from "./fixtures/legacy-protocol-writer.ts";
import * as FileSystem from "effect/FileSystem";
import {
  assertBarrierInventory,
  assertClean,
  assertConverged,
  assertSingleRunner,
  census as censusProcessDeath,
  deploy,
  evidencePaths,
  heldLeases,
  identity,
  machine,
  matchesBarrier,
  nowSeconds,
  observeLeaseExpiry,
  persistedRow,
  phases,
  processDeathFile,
  readWitness,
  writeEvidence,
  type Phase,
  type Witness,
} from "./fixtures/process-death.ts";
import { GatewayTimeout as GatewayTimeoutErrors } from "@distilled.cloud/fly-io/Errors";
import { alchemyMetadataKeys as keys } from "@/Fly/Metadata";
import {
  appName,
  candidateId,
  metadata,
  protocolClient,
  reconcile,
  reply,
  withControlledClient,
} from "./fixtures/protocol-branches.ts";
import * as Data from "effect/Data";
import { randomBytes, createHash } from "node:crypto";
import {
  Site,
  Token,
  TRIGGER_SECRET,
  Writer,
  writerLayer,
} from "./fixtures/bluegreen-runtime-secrets/writer.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import {
  BoundSecrets,
  CacheOne,
  CacheTwo,
  Site as SiteBluegreenSecrets,
} from "./fixtures/bluegreen-secrets.ts";
import * as Stream from "effect/Stream";
import {
  assertOrder,
  assertReplacement,
  assertStopped,
  makeScenario,
  requireValue,
} from "./fixtures/bluegreen-worker-test.ts";
import {
  Finalized,
  RunnerInterrupted,
  Witness as WitnessSignalOverlap,
  assertBoundary,
  assertConverged as assertConvergedSignalOverlap,
  assertInventory,
  assertReleased,
  assertSingleRunner as assertSingleRunnerSignalOverlap,
  boundary,
  cases,
  firstReturnedUncordon,
  matches,
  observeExpiry,
  observeLeases,
  pathsFor,
  readEvidence,
  signalOverlapFile,
  successful,
  type SignalCase,
} from "./fixtures/signal-overlap.ts";
import * as Alchemy from "@/index";
import { localState, makeLocalState } from "@/State/LocalState";
import {
  delayedResourceWrite,
  ResourceRow,
} from "./fixtures/state-persistence.ts";
import MountedBlueGreen from "./fixtures/mounted-bluegreen.ts";

describe.sequential(
  "deployment",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "S01 bluegreen worker checks, promotion, replacement, and graceful teardown",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (version: string, path = "/") =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  name: "bluegreen-worker-long-name-base",
                  image: "nginx:alpine",
                  env: { VERSION: version },
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "30 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                  checks: {
                    ready: {
                      type: "http",
                      port: 80,
                      path,
                      interval: "2s",
                      timeout: "1s",
                    },
                  },
                });
              }),
            );
          const first = yield* deploy("one");
          const committed = yield* machines.getMachine({
            app_name: first.appName,
            machine_id: first.machineId,
          });
          // Active commit metadata can reset reports after the provider's readiness validation.
          const machine = yield* waitHealthy(first.appName, committed, 30_000);
          expect(machine.instance_id).toBe(committed.instance_id);
          yield* Effect.logInfo("Observed promoted worker", {
            checks: machine.checks?.map(({ name, status }) => ({
              name,
              status,
            })),
            configured: machine.config?.checks,
            metadata: machine.config?.metadata,
          });
          expect(machine.cordoned).toBe(false);
          expect(
            machine.checks?.some(
              (check) => check.name === "ready" && check.status === "passing",
            ),
          ).toBe(true);
          expect(machine.config?.metadata?.["alchemy.phase"]).toBe("active");
          expect(first.name.length).toBeLessThanOrEqual(30);
          const second = yield* deploy("two");
          expect(second.machineId).not.toBe(first.machineId);
          expect(second.baseName).toBe(first.baseName);
          const listed = yield* machines.listMachines({
            app_name: first.appName,
          });
          expect(
            listed
              .filter((machine) => machine.state !== "destroyed")
              .map((machine) => machine.id),
          ).toEqual([second.machineId]);
          yield* stack.destroy();
          yield* assertAppGone(first.appName);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "S04 unhealthy replacement preserves the old routed ID and cleans unpromoted candidates",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const failed = yield* deployWorker(stack, "broken", {
            checks: { ready: { ...checks.ready, path: "/missing" } },
            deploy: { strategy: "bluegreen", healthTimeout: "8 seconds" },
          }).pipe(Effect.result);
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed))
            expect(failed.failure).toMatchObject({
              _tag: "Fly.ReplicaChecksNotPassing",
            });
          const live = yield* census(initial.appName);
          expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
          expect(live[0]!.state).toBe("started");
          expect(live[0]!.cordoned).toBe(false);
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "App deletion",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "F11 ambiguous name-addressed App deletion does not blindly retry",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const proxy = yield* transportProxy();
          const actor = yield* engineActor(
            stack,
            "F11 ambiguous name-addressed App deletion does not blindly retry",
            "test/Fly/BlueGreen.test.ts",
            proxy.url,
          );
          yield* Effect.sync(() => {
            proxy.arm({
              match: (event) =>
                event.method === "DELETE" &&
                event.path === `/v1/apps/${app.appName}`,
              action: "drop-response",
              remaining: Infinity,
            });
          });
          const result = yield* actor
            .destroy()
            .pipe(Effect.timeout("45 seconds"), Effect.result);
          assert(Result.isFailure(result));
          assert(result.failure instanceof DestroyError);
          expect(result.failure.blocked).toEqual([]);
          expect(result.failure.failures).toHaveLength(1);
          const failure = result.failure.failures[0]!;
          expect(failure.logicalId).toBe("Site");
          expect(failure.resourceType).toBe("Fly.App");
          const cause = Cause.findError(failure.cause);
          assert(Result.isSuccess(cause));
          assert(cause.success instanceof AppDeletionAmbiguous);
          expect(cause.success).toMatchObject({
            _tag: "Fly.AppDeletionAmbiguous",
            appName: app.appName,
            evidence: "HttpClientError",
          });
          const attempts = proxy.events.filter(
            (event) =>
              event.stage === "request" &&
              event.method === "DELETE" &&
              event.path === `/v1/apps/${app.appName}`,
          );
          expect(attempts).toHaveLength(1);
          expect(
            proxy.events.some(
              (event) =>
                event.stage === "dropped" &&
                event.status! >= 200 &&
                event.status! < 300,
            ),
          ).toBe(true);
          yield* Effect.sync(proxy.clear);
          yield* assertAppGone(app.appName);
          // An explicit cleanup after observing absence is not an automatic transport retry.
          yield* stack.destroy();
        }).pipe(Effect.scoped),
      { timeout: 180_000 },
    );

    test.provider(
      "F11 ambiguous App deletion cannot retry into an independently recreated same-name successor",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          expect(app.orgSlug).toBeDefined();
          const proxy = yield* transportProxy();
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) =>
                event.method === "DELETE" &&
                event.path === `/v1/apps/${app.appName}`,
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const actor = yield* engineActor(
              stack,
              "F11 ambiguous App deletion cannot retry into an independently recreated same-name successor",
              "test/Fly/BlueGreen.test.ts",
              proxy.url,
            );
            const deletion = yield* actor
              .destroy()
              .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
            yield* proxy.wait(
              (event) =>
                event.stage === "held" &&
                event.status! >= 200 &&
                event.status! < 300,
            );
            yield* assertAppGone(app.appName);
            // This independent API actor demonstrates the missing cross-process tombstone, not safe automatic recreation.
            yield* machines
              .createApp({ name: app.appName, org_slug: app.orgSlug! })
              .pipe(Retry.none, Effect.provide(FetchHttpClient.layer));
            yield* Effect.gen(function* () {
              const successor = yield* machines
                .createMachine({
                  app_name: app.appName,
                  name: "successor-sentinel",
                  region: "iad",
                  config: { image: "nginx:alpine" },
                })
                .pipe(Effect.provide(FetchHttpClient.layer));
              yield* Effect.sync(proxy.dropHeld);
              const result = yield* Fiber.join(deletion).pipe(
                Effect.timeout("45 seconds"),
              );
              expect(
                proxy.events.filter(
                  (event) =>
                    event.stage === "request" &&
                    event.method === "DELETE" &&
                    event.path === `/v1/apps/${app.appName}`,
                ),
              ).toHaveLength(1);
              assert(Result.isFailure(result));
              assert(result.failure instanceof DestroyError);
              expect(result.failure.blocked).toEqual([]);
              expect(result.failure.failures).toHaveLength(1);
              const failure = result.failure.failures[0]!;
              expect(failure.logicalId).toBe("Site");
              expect(failure.resourceType).toBe("Fly.App");
              const cause = Cause.findError(failure.cause);
              assert(Result.isSuccess(cause));
              assert(cause.success instanceof AppDeletionAmbiguous);
              expect(cause.success).toMatchObject({
                _tag: "Fly.AppDeletionAmbiguous",
                appName: app.appName,
                evidence: "HttpClientError",
              });
              const surviving = yield* machines
                .getMachine({
                  app_name: app.appName,
                  machine_id: successor.id!,
                })
                .pipe(Effect.provide(FetchHttpClient.layer));
              expect(surviving.id).toBe(successor.id);
              expect(surviving.name).toBe("successor-sentinel");
            }).pipe(
              Effect.ensuring(
                // Only the independent fixture owner removes its successor; the uncertain engine is not retried against it.
                machines.deleteApp({ app_name: app.appName }).pipe(
                  Retry.none,
                  Effect.catchTag("NotFound", () => Effect.void),
                  Effect.provide(FetchHttpClient.layer),
                  Effect.orDie,
                ),
              ),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.dropHeld();
              }),
            ),
            Effect.scoped,
          );
          yield* assertAppGone(app.appName);
          yield* stack.destroy();
        }).pipe(Effect.scoped),
      { timeout: 300_000 },
    );
  },
);

describe.sequential(
  "App deletion verification",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    for (const fault of [
      { action: "cut-request", stage: "cut", error: "HttpClientError" },
      { action: "hold-response", stage: "held", error: "TimeoutError" },
    ] as const) {
      test.provider(
        `F11 accepted App deletion reports bounded ambiguity for ${fault.action} verification GET`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const app = yield* stack.deploy(Fly.App("Site"));
            const proxy = yield* transportProxy();
            const actor = yield* engineActor(
              stack,
              `F11 accepted App deletion reports bounded ambiguity for ${fault.action} verification GET`,
              "test/Fly/BlueGreen.test.ts",
              proxy.url,
            );
            const path = `/v1/apps/${app.appName}`;
            yield* Effect.gen(function* () {
              yield* Effect.sync(() =>
                proxy.arm({
                  match: (event) =>
                    event.method === "GET" &&
                    event.path === path &&
                    proxy.events.some(
                      (accepted) =>
                        accepted.stage === "forwarded" &&
                        accepted.method === "DELETE" &&
                        accepted.path === path &&
                        accepted.status! >= 200 &&
                        accepted.status! < 300,
                    ),
                  action: fault.action,
                  remaining: Infinity,
                }),
              );
              const deletion = yield* actor
                .destroy()
                .pipe(Effect.result, Effect.forkScoped);
              const accepted = yield* proxy.wait(
                (event) =>
                  event.stage === "forwarded" &&
                  event.method === "DELETE" &&
                  event.path === path &&
                  event.status! >= 200 &&
                  event.status! < 300,
              );
              const verification = yield* proxy.wait(
                (event) =>
                  event.stage === fault.stage &&
                  event.method === "GET" &&
                  event.path === path,
              );
              expect(verification.sequence).toBeGreaterThan(accepted.sequence);
              const result = yield* Fiber.join(deletion).pipe(
                Effect.timeout("45 seconds"),
              );
              assert(Result.isFailure(result));
              assert(result.failure instanceof DestroyError);
              expect(result.failure.blocked).toEqual([]);
              expect(result.failure.failures).toHaveLength(1);
              const failure = result.failure.failures[0]!;
              expect(failure.logicalId).toBe("Site");
              expect(failure.resourceType).toBe("Fly.App");
              const cause = Cause.findError(failure.cause);
              assert(Result.isSuccess(cause));
              assert(cause.success instanceof AppDeletionAmbiguous);
              expect(cause.success).toMatchObject({
                _tag: "Fly.AppDeletionAmbiguous",
                appName: app.appName,
                evidence: `delete accepted but absence verification failed: ${fault.error}`,
              });
              expect(cause.success.message).toContain(
                "reconcile the App before retrying or recreating its name",
              );
              expect(
                proxy.events.filter(
                  (event) =>
                    event.stage === "request" &&
                    event.method === "DELETE" &&
                    event.path === path,
                ),
              ).toHaveLength(1);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  proxy.clear();
                  proxy.dropHeld();
                }),
              ),
            );
            yield* assertAppGone(app.appName);
            // Explicit cleanup follows out-of-band absence, not a blind DELETE retry.
            yield* stack.destroy();
            yield* assertAppGone(app.appName);
          }).pipe(Effect.scoped),
        { timeout: 300_000 },
      );
    }
  },
);

describe.sequential(
  "autostop",
  { tags: ["provider:fly", "provider:fly:service"] },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    it.effect(
      "S03 check identity rejects duplicate, missing, warning and unknown reports",
      () =>
        Effect.sync(() => {
          const config = {
            checks: { ready: { type: "http", port: 80 } },
            services: [{ internal_port: 80, checks: [{ type: "http" }] }],
          };
          const checks = [
            { name: "ready", status: "passing" },
            { name: "servicecheck-00-http-80", status: "passing" },
          ];
          expect(checksPassing({ state: "started", checks }, config)).toBe(
            true,
          );
          expect(checksPassing({ state: "stopped", checks }, config)).toBe(
            false,
          );
          for (const invalid of [
            [],
            checks.slice(0, 1),
            [checks[0]!, checks[0]!],
            [...checks, { name: "unknown", status: "passing" }],
            checks.map((check) => ({ ...check, status: "warning" })),
          ]) {
            expect(
              checksPassing({ state: "started", checks: invalid }, config),
            ).toBe(false);
          }
        }),
      { tags: ["unit", "local"] },
    );

    it.effect(
      "S05 deterministic representatives, floors, scale-up and mixed-service roles",
      () =>
        Effect.sync(() => {
          const services = [{ autostop: "stop", min_machines_running: 0 }];
          expect(readinessRoles({ services }, 3, [])).toEqual([
            "run",
            "idle",
            "idle",
          ]);
          const running = [
            {
              state: "started",
              config: { metadata: { "alchemy.replica": "1" } },
            },
          ];
          expect(readinessRoles({ services }, 3, running)).toEqual([
            "idle",
            "run",
            "idle",
          ]);
          expect(
            readinessRoles(
              { services: [{ autostop: "suspend", min_machines_running: 2 }] },
              3,
              running,
            ),
          ).toEqual(["run", "run", "idle"]);
          expect(
            readinessRoles(
              { services: [...services, { autostop: "off" }] },
              3,
              [],
            ),
          ).toEqual(["run", "run", "run"]);
        }),
      { tags: ["unit", "local"] },
    );

    for (const autostop of ["stop", "suspend"] as const) {
      test.provider(
        `S05 S11 ${autostop} all-idle replacement preserves nonrepresentatives`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const deploy = (version: string, healthTimeout = 20_000) =>
              stack.deploy(
                Effect.gen(function* () {
                  const app = yield* Fly.App("Site");
                  return yield* Fly.Machine("Worker", {
                    app,
                    image: "nginx:alpine",
                    count: 2,
                    env: { VERSION: version },
                    deploy: { strategy: "bluegreen", healthTimeout },
                    shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                    services: [
                      {
                        protocol: "tcp",
                        internalPort: 80,
                        autostop,
                        autostart: true,
                        minMachinesRunning: 0,
                        checks: [
                          {
                            type: "http",
                            port: 80,
                            path: "/",
                            interval: "2s",
                            timeout: "1s",
                          },
                        ],
                      },
                    ],
                  });
                }),
              );
            const first = yield* deploy("one");
            const firstIdle = yield* machines.getMachine({
              app_name: first.appName,
              machine_id: first.machineIds[1]!,
            });
            expect(firstIdle.config?.metadata?.["alchemy.readiness-role"]).toBe(
              "idle",
            );
            expect(firstIdle.state).not.toBe("started");
            const primary = {
              app_name: first.appName,
              machine_id: first.machineId,
            };
            if (autostop === "suspend") yield* machines.suspendMachine(primary);
            else
              yield* machines.stopMachine({
                ...primary,
                signal: "SIGQUIT",
                timeout: "10s",
              });
            yield* machines.waitMachine({
              ...primary,
              state: autostop === "suspend" ? "suspended" : "stopped",
              timeout: 8,
            });
            const second = yield* deploy("two");
            expect(
              second.machineIds.every((id) => !first.machineIds.includes(id)),
            ).toBe(true);
            const live = (yield* machines.listMachines({
              app_name: second.appName,
            })).filter((machine) => machine.state !== "destroyed");
            expect(live.map((machine) => machine.id).sort()).toEqual(
              [...second.machineIds].sort(),
            );
            const nonrepresentative = live.find(
              (machine) =>
                machine.config?.metadata?.["alchemy.replica"] === "1",
            );
            expect(nonrepresentative?.state).not.toBe("started");
            expect(nonrepresentative?.config?.metadata?.["alchemy.phase"]).toBe(
              "active",
            );
            expect(
              autostopMode(nonrepresentative?.config?.services?.[0]?.autostop),
            ).toBe(autostop);
            const committed = {
              app_name: second.appName,
              machine_id: second.machineId,
            };
            if (autostop === "suspend")
              yield* machines.suspendMachine(committed);
            else
              yield* machines.stopMachine({
                ...committed,
                signal: "SIGQUIT",
                timeout: "10s",
              });
            yield* machines.waitMachine({
              ...committed,
              state: autostop === "suspend" ? "suspended" : "stopped",
              timeout: 8,
            });
            const unchanged = yield* deploy("two", 22_000);
            expect(unchanged.machineIds).toEqual(second.machineIds);
            expect((yield* machines.getMachine(committed)).state).not.toBe(
              "started",
            );
            yield* stack.destroy();
            expect(
              yield* machines.listMachines({ app_name: second.appName }).pipe(
                Effect.map((machines) =>
                  machines.filter((machine) => machine.state !== "destroyed"),
                ),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
            ).toEqual([]);
          }),
        {
          tags: ["provider:fly:app", "provider:fly:machine", "live"],
          timeout: 120_000,
        },
      );
    }

    for (const autostop of ["stop", "suspend"] as const) {
      test.provider(
        `P3 ${autostop} cordoned readiness and restored instance probe`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const output = yield* stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  skipLaunch: true,
                  services: [
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop,
                      autostart: true,
                      minMachinesRunning: 0,
                      ports: [{ port: 80, handlers: ["http"] }],
                      checks: [
                        {
                          type: "http",
                          port: 80,
                          path: "/",
                          interval: "2s",
                          timeout: "1s",
                        },
                        {
                          type: "tcp",
                          port: 80,
                          interval: "2s",
                          timeout: "1s",
                        },
                      ],
                    },
                    {
                      protocol: "tcp",
                      internalPort: 81,
                      autostop,
                      autostart: true,
                      checks: [
                        {
                          type: "http",
                          port: 80,
                          path: "/",
                          interval: "2s",
                          timeout: "1s",
                        },
                      ],
                    },
                  ],
                });
              }),
            );
            const request = {
              app_name: output.appName,
              machine_id: output.machineId,
            };
            const original = yield* machines.getMachine(request);
            yield* machines.cordonMachine(request);
            const prepared = yield* machines.updateMachine({
              ...request,
              config: {
                ...original.config,
                services: original.config?.services?.map((service) => ({
                  ...service,
                  autostop: "off",
                })),
              },
              skip_launch: true,
              skip_service_registration: true,
            });
            const ready = yield* ensureStarted(
              output.appName,
              prepared,
              false,
              30_000,
            );
            expect(ready.cordoned).toBe(true);
            yield* machines.uncordonMachine(request);
            const restored = yield* machines.updateMachine({
              ...request,
              config: original.config,
            });
            const fresh = yield* ensureStarted(
              output.appName,
              restored,
              false,
              30_000,
            );
            yield* waitHealthy(output.appName, fresh, 30_000);
            yield* Effect.logInfo("P3 restored idle policy", {
              autostop,
              beforeInstance: ready.instance_id,
              afterInstance: fresh.instance_id,
              state: fresh.state,
              checks: fresh.checks?.map((check) => ({
                name: check.name,
                status: check.status,
              })),
            });
            expect(autostopMode(fresh.config?.services?.[0]?.autostop)).toBe(
              autostop,
            );
            if (autostop === "suspend") yield* machines.suspendMachine(request);
            else
              yield* machines.stopMachine({
                ...request,
                signal: "SIGQUIT",
                timeout: "10s",
              });
            yield* machines.waitMachine({
              ...request,
              state: autostop === "suspend" ? "suspended" : "stopped",
              timeout: 8,
            });
            const idle = yield* machines.getMachine(request);
            expect(idle.state).toBe(
              autostop === "suspend" ? "suspended" : "stopped",
            );
            yield* stack.destroy();
            expect(
              yield* machines.getMachine(request).pipe(
                Effect.map((machine) => machine.state === "destroyed"),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }),
        {
          tags: ["provider:fly:app", "provider:fly:machine", "live"],
          timeout: 120_000,
        },
      );
    }

    for (const autostop of ["stop", "suspend"] as const) {
      test.provider(
        `P3 public ${autostop} restored policy autostarts on real traffic`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const output = yield* stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                return yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "20 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                  services: [
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop,
                      autostart: true,
                      minMachinesRunning: 0,
                      ports: [{ port: 80, handlers: ["http"] }],
                      checks: [
                        {
                          type: "http",
                          port: 80,
                          path: "/",
                          interval: "2s",
                          timeout: "1s",
                        },
                      ],
                    },
                  ],
                });
              }),
            );
            const request = {
              app_name: output.appName,
              machine_id: output.machineId,
            };
            if (autostop === "suspend") yield* machines.suspendMachine(request);
            else
              yield* machines.stopMachine({
                ...request,
                signal: "SIGQUIT",
                timeout: "10s",
              });
            yield* machines.waitMachine({
              ...request,
              state: autostop === "suspend" ? "suspended" : "stopped",
              timeout: 8,
            });
            const client = yield* HttpClient.HttpClient;
            const response = yield* client
              .get(`http://${output.appName}.fly.dev`)
              .pipe(
                Effect.retry({
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                }),
              );
            expect(response.status).toBe(200);
            expect(yield* response.text).toContain("Welcome to nginx");
            const awakened = yield* machines.getMachine(request);
            expect(awakened.state).toBe("started");
            expect(autostopMode(awakened.config?.services?.[0]?.autostop)).toBe(
              autostop,
            );
            yield* stack.destroy();
            expect(
              yield* machines.getMachine(request).pipe(
                Effect.map((machine) => machine.state === "destroyed"),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }),
        {
          tags: [
            "provider:fly:app",
            "provider:fly:ipassignment",
            "provider:fly:machine",
            "live",
          ],
          timeout: 120_000,
        },
      );
    }
  },
);

describe.sequential(
  "commit recovery",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:secret",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    const { test } = Test.make({ providers: Fly.providers() });

    for (const interrupted of [false, true]) {
      test.provider(
        `FLY-REVIEW-1 first-deploy ${interrupted ? "interrupted" : "failed"} final readiness stays pending and cannot shortcut recovery`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const readiness = yield* makeReadinessControl();
            const site = yield* readiness.deployApp(stack);
            const proxy = yield* transportProxy();
            yield* Effect.sync(() =>
              proxy.arm({
                match: (event) =>
                  event.path.endsWith("/metadata") &&
                  event.phase === "validating",
                action: "hold-response",
                remaining: 1,
              }),
            );
            const actor = yield* engineActor(
              stack,
              `FLY-REVIEW-1 first-deploy ${interrupted ? "interrupted" : "failed"} final readiness stays pending and cannot shortcut recovery`,
              file,
              proxy.url,
            );
            const attempt = yield* readiness
              .deployWorker(actor, "one")
              .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
            const barrier = yield* proxy
              .wait(
                (event) =>
                  event.stage === "held" &&
                  event.phase === "validating" &&
                  event.status! >= 200 &&
                  event.status! < 300,
              )
              .pipe(
                Effect.raceFirst(
                  Effect.gen(function* () {
                    const result = yield* Fiber.join(attempt);
                    if (Result.isFailure(result))
                      return yield* Effect.fail(result.failure);
                    return yield* Effect.fail(
                      new Error(
                        "Deployment completed without reaching the validating barrier",
                      ),
                    );
                  }),
                ),
              );
            const machineId = barrier.machineId!;
            expect(machineId).toBeDefined();

            const firstRouting = proxy.events.findIndex(
              (event) =>
                event.stage === "request" && event.path.endsWith("/uncordon"),
            );
            expect(firstRouting).toBeGreaterThan(0);
            const preparation = proxy.events.slice(0, firstRouting);
            const promoting = preparation.findLastIndex(
              (event) =>
                event.stage === "completed" &&
                event.phase === "promoting" &&
                event.path.endsWith("/metadata") &&
                event.status! < 300,
            );
            const ready = preparation.findLastIndex(
              (event) =>
                event.stage === "completed" &&
                event.method === "GET" &&
                event.path.endsWith(`/machines/${machineId}`) &&
                event.state === "started" &&
                event.cordoned === true &&
                event.checks?.find((check) => check.name === "ready")
                  ?.status === "passing",
            );
            expect(promoting).toBeGreaterThanOrEqual(0);
            expect(ready).toBeGreaterThan(promoting);

            yield* readiness.turnOff(site.appName, machineId);
            if (interrupted) {
              const interruption = yield* Fiber.interrupt(attempt).pipe(
                Effect.forkScoped,
              );
              yield* Effect.yieldNow;
              yield* Effect.sync(proxy.release);
              yield* Fiber.join(interruption).pipe(
                Effect.timeout("180 seconds"),
              );
              expect(Exit.hasInterrupts(yield* Fiber.await(attempt))).toBe(
                true,
              );
            } else {
              yield* Effect.sync(proxy.release);
              const result = yield* Fiber.join(attempt).pipe(
                Effect.timeout("180 seconds"),
              );
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect(result.failure._tag).toBe("Fly.ReplicaChecksNotPassing");
            }
            yield* Effect.sync(proxy.clear);
            const pending = yield* census(site.appName);
            expect(pending.map((machine) => machine.id)).toEqual([machineId]);
            expect(pending[0]!.cordoned).toBe(false);
            const metadata = pending[0]!.config!.metadata!;
            expect(metadata["alchemy.phase"]).toBe("validating");
            expect(metadata["alchemy.checked-instance"]).toBeUndefined();
            const read = yield* observeReplicaSet({
              appName: site.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: metadata["alchemy.fqn"]!,
              resourceInstanceId: metadata["alchemy.instance"]!,
              machineIds: [machineId],
            });
            expect(read?.rolloutPending).toBe(true);
            expect(read?.machineIds).toEqual([]);

            const retryActor = yield* engineActor(
              stack,
              `FLY-REVIEW-1 first-deploy ${interrupted ? "interrupted" : "failed"} final readiness stays pending and cannot shortcut recovery`,
              file,
              proxy.url,
            );
            const stillBroken = yield* readiness
              .deployWorker(retryActor, "one")
              .pipe(Effect.scoped, Effect.result);
            expect(Result.isFailure(stillBroken)).toBe(true);
            if (Result.isFailure(stillBroken))
              expect(stillBroken.failure._tag).toBe(
                "Fly.ReplicaChecksNotPassing",
              );
            expect(
              (yield* census(site.appName)).map((machine) => machine.id),
            ).toEqual([machineId]);
            expect(
              proxy.events.some(
                (event) =>
                  event.phase === "active" && event.path.endsWith("/metadata"),
              ),
            ).toBe(false);

            yield* repairReadiness(site.appName, machineId);
            const recoveryActor = yield* engineActor(
              stack,
              `FLY-REVIEW-1 first-deploy ${interrupted ? "interrupted" : "failed"} final readiness stays pending and cannot shortcut recovery`,
              file,
              proxy.url,
            );
            const recovered = yield* readiness
              .deployWorker(recoveryActor, "one")
              .pipe(Effect.scoped);
            expect(recovered.machineIds).toEqual([machineId]);
            yield* assertCommitted(site.appName, recovered.machineIds);
            const committed = yield* observeReplicaSet({
              appName: site.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: metadata["alchemy.fqn"]!,
              resourceInstanceId: metadata["alchemy.instance"]!,
              machineIds: [machineId],
            });
            expect(committed?.rolloutPending).toBe(false);
            expect(committed?.machineIds).toEqual([machineId]);
            yield* stack.destroy();
            yield* assertAppGone(site.appName);
          }).pipe(Effect.scoped),
        { timeout: 600_000 },
      );
    }
  },
);

describe.sequential(
  "concurrency",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "F11 an actual delayed Machine-list snapshot cannot retire a newer generation before fresh readiness",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) =>
                event.method === "GET" && event.path.endsWith("/machines"),
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const staleActor = yield* engineActor(
              stack,
              "F11 an actual delayed Machine-list snapshot cannot retire a newer generation before fresh readiness",
              file,
              proxy.url,
            );
            const freshActor = yield* engineActor(
              stack,
              "F11 an actual delayed Machine-list snapshot cannot retire a newer generation before fresh readiness",
              file,
            );
            const delayed = yield* deployWorker(staleActor, "two").pipe(
              Effect.scoped,
              Effect.result,
              Effect.forkScoped,
            );
            yield* proxy.wait(
              (event) => event.stage === "held" && event.status === 200,
            );
            const newer = yield* deployWorker(freshActor, "three");
            expect(newer.machineId).not.toBe(initial.machineId);
            expect(
              proxy.events.some(
                (event) => event.stage === "request" && event.method !== "GET",
              ),
            ).toBe(false);
            yield* Effect.sync(proxy.release);
            const result = yield* Fiber.join(delayed).pipe(
              Effect.timeout("180 seconds"),
            );
            if (Result.isSuccess(result)) {
              // A later valid reconcile may win; native leases do not fence LocalState with a global epoch.
              yield* assertCommitted(
                initial.appName,
                result.success.machineIds,
              );
              for (const id of newer.machineIds) {
                const retire = proxy.events.findIndex(
                  (event) =>
                    event.stage === "request" &&
                    event.machineId === id &&
                    (event.path.endsWith("/stop") ||
                      event.path.endsWith("/cordon") ||
                      (event.method === "DELETE" &&
                        !event.path.endsWith("/lease"))),
                );
                expect(retire).toBeGreaterThan(0);
                for (const candidate of result.success.machineIds) {
                  expect(
                    proxy.events
                      .slice(0, retire)
                      .some(
                        (event) =>
                          event.stage === "completed" &&
                          event.machineId === candidate &&
                          event.method === "GET" &&
                          event.state === "started" &&
                          event.checks?.some(
                            (check) =>
                              check.name === "ready" &&
                              check.status === "passing",
                          ),
                      ),
                  ).toBe(true);
                }
              }
            } else {
              expect([
                "Fly.DeploymentRecoveryAmbiguous",
                "Fly.ReplicaOwnershipChanged",
                "Fly.MachineLeaseBusy",
                "Fly.MachineLeaseLost",
                "NotFound",
              ]).toContain(result.failure._tag);
              expect(
                (yield* census(initial.appName)).some(
                  (machine) => machine.id === newer.machineId,
                ),
              ).toBe(true);
              yield* Effect.logInfo(
                "Stale snapshot refused without state-fencing guarantee",
                { outcome: result.failure._tag },
              );
            }
            const resumed = yield* engineActor(
              stack,
              "F11 an actual delayed Machine-list snapshot cannot retire a newer generation before fresh readiness",
              file,
            );
            const settled = yield* deployWorker(resumed, "four");
            yield* assertCommitted(initial.appName, settled.machineIds);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.release();
              }),
            ),
            Effect.scoped,
          );
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    );

    describe.sequential("independent engine contexts", () => {
      for (const competitor of ["bluegreen", "rolling", "destroy"] as const) {
        test.provider(
          `F11 shared-old lease excludes ${competitor} while a candidate response is held`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const initial = yield* deployWorker(stack, "one");
              const holderProxy = yield* transportProxy();
              const contenderProxy = yield* transportProxy();
              yield* Effect.sync(() =>
                holderProxy.arm({
                  match: (event) =>
                    event.method === "POST" && event.path.endsWith("/machines"),
                  action: "hold-response",
                  remaining: 1,
                }),
              );
              yield* Effect.gen(function* () {
                const holderActor = yield* engineActor(
                  stack,
                  `F11 shared-old lease excludes ${competitor} while a candidate response is held`,
                  file,
                  holderProxy.url,
                );
                const contenderActor = yield* engineActor(
                  stack,
                  `F11 shared-old lease excludes ${competitor} while a candidate response is held`,
                  file,
                  contenderProxy.url,
                );
                expect(contenderActor.state).not.toBe(holderActor.state);
                const holder = yield* deployWorker(holderActor, "two").pipe(
                  Effect.scoped,
                  Effect.forkScoped,
                );
                const held = yield* holderProxy.wait(
                  (event) => event.stage === "held" && event.status! < 300,
                );
                const operation =
                  competitor === "destroy"
                    ? contenderActor.destroy()
                    : deployWorker(contenderActor, "three", {
                        deploy: {
                          strategy: competitor,
                          healthTimeout: "30 seconds",
                        },
                      }).pipe(Effect.asVoid);
                const result = yield* operation.pipe(
                  Effect.scoped,
                  Effect.timeout("75 seconds"),
                  Effect.result,
                );
                yield* Effect.sync(holderProxy.release);
                expect(Result.isFailure(result)).toBe(true);
                if (Result.isFailure(result))
                  expect(result.failure).not.toMatchObject({
                    _tag: "TimeoutError",
                  });
                expect(
                  contenderProxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.status === 409 &&
                      event.path.endsWith("/lease") &&
                      event.machineId === initial.machineId,
                  ),
                ).toBe(true);
                expect(
                  contenderProxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.status! < 300 &&
                      event.method !== "GET" &&
                      !event.path.endsWith("/lease"),
                  ),
                ).toBe(false);
                const next = yield* Fiber.join(holder).pipe(
                  Effect.timeout("90 seconds"),
                );
                expect(next.machineIds).toEqual([held.machineId]);
                expect(
                  (yield* census(initial.appName)).map((machine) => machine.id),
                ).toEqual(next.machineIds);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    holderProxy.clear();
                    holderProxy.release();
                  }),
                ),
                Effect.scoped,
              );
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(Effect.scoped),
          { timeout: 300_000 },
        );
      }

      test.provider(
        "S02 F11 concurrent first Machine engine deployments preserve ownership without assuming a global lock",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const app = yield* stack.deploy(Fly.App("Site"));
            const firstProxy = yield* transportProxy();
            const secondProxy = yield* transportProxy();
            yield* Effect.sync(() =>
              firstProxy.arm({
                match: (event) =>
                  event.method === "POST" && event.path.endsWith("/machines"),
                action: "hold-response",
                remaining: 1,
              }),
            );
            yield* Effect.gen(function* () {
              const firstActor = yield* engineActor(
                stack,
                "S02 F11 concurrent first Machine engine deployments preserve ownership without assuming a global lock",
                file,
                firstProxy.url,
              );
              const secondActor = yield* engineActor(
                stack,
                "S02 F11 concurrent first Machine engine deployments preserve ownership without assuming a global lock",
                file,
                secondProxy.url,
              );
              const first = yield* deployWorker(firstActor, "one").pipe(
                Effect.scoped,
                Effect.result,
                Effect.forkScoped,
              );
              const created = yield* firstProxy.wait(
                (event) => event.stage === "held" && event.status! < 300,
              );
              const original = (yield* census(app.appName)).find(
                (machine) => machine.id === created.machineId,
              );
              const owner = original?.config?.metadata;
              expect(owner?.["alchemy.fqn"]).toBeTruthy();
              expect(owner?.["alchemy.instance"]).toBeTruthy();
              expect(
                firstProxy.events.some(
                  (event) =>
                    event.stage === "completed" &&
                    event.method === "POST" &&
                    event.path.endsWith("/lease") &&
                    event.status! < 300,
                ),
              ).toBe(false);
              const second = yield* deployWorker(secondActor, "two").pipe(
                Effect.scoped,
                Effect.timeout("90 seconds"),
                Effect.result,
              );
              const during = yield* census(app.appName);
              yield* Effect.sync(firstProxy.release);
              const firstResult = yield* Fiber.join(first).pipe(
                Effect.timeout("90 seconds"),
              );
              yield* Effect.logInfo(
                "First-deploy results: no global exclusion promised",
                {
                  first: Result.isFailure(firstResult)
                    ? firstResult.failure._tag
                    : firstResult._tag,
                  second: Result.isFailure(second)
                    ? second.failure._tag
                    : second._tag,
                },
              );
              const successfulIds: string[] = [];
              for (const result of [firstResult, second]) {
                if (Result.isSuccess(result)) {
                  expect(result.success.machineIds.length).toBe(1);
                  successfulIds.push(...result.success.machineIds);
                } else {
                  expect([
                    "Fly.DeploymentRecoveryAmbiguous",
                    "Fly.ReplicaOwnershipChanged",
                    "Fly.MachineLeaseBusy",
                    "Fly.MachineLeaseLost",
                    "Fly.MachineNotCreated",
                    "NotFound",
                  ]).toContain(result.failure._tag);
                }
              }
              expect(successfulIds.length).toBeGreaterThan(0);
              // A held create response conveys no lease; a leased, ready successor may retire it.
              if (Result.isSuccess(second)) {
                const committed = yield* assertCommitted(
                  app.appName,
                  second.success.machineIds,
                );
                for (const machine of committed) {
                  yield* waitHealthy(
                    app.appName,
                    machine,
                    30_000,
                    machine.config,
                  );
                }
                expect(during.map((machine) => machine.id).sort()).toEqual(
                  [...second.success.machineIds].sort(),
                );
                expect(
                  during.every(
                    (machine) =>
                      machine.state === "started" &&
                      machine.cordoned === false &&
                      machine.config?.metadata?.["alchemy.phase"] === "active",
                  ),
                ).toBe(true);
              } else {
                expect(
                  during.some((machine) => machine.id === created.machineId),
                ).toBe(true);
              }
              const createdIds = new Set(
                [firstProxy, secondProxy].flatMap((proxy) =>
                  proxy.events
                    .filter(
                      (event) =>
                        event.stage === "completed" &&
                        event.method === "POST" &&
                        event.path.endsWith("/machines") &&
                        event.status! < 300,
                    )
                    .map((event) => event.machineId),
                ),
              );
              for (const proxy of [firstProxy, secondProxy]) {
                for (const [index, event] of proxy.events.entries()) {
                  if (
                    event.stage !== "request" ||
                    !(
                      event.path.endsWith("/stop") ||
                      event.path.endsWith("/cordon") ||
                      event.phase === "retiring" ||
                      (event.method === "DELETE" &&
                        /\/machines\/[^/]+$/.test(event.path))
                    )
                  )
                    continue;
                  expect(event.machineId).toBeDefined();
                  expect(createdIds.has(event.machineId)).toBe(true);
                  const before = proxy.events.slice(0, index);
                  const lease = before.findIndex(
                    (prior) =>
                      prior.stage === "completed" &&
                      prior.machineId === event.machineId &&
                      prior.method === "POST" &&
                      prior.path.endsWith("/lease") &&
                      prior.status! < 300,
                  );
                  expect(lease).toBeGreaterThan(-1);
                  expect(
                    before
                      .slice(lease + 1)
                      .some(
                        (prior) =>
                          prior.stage === "completed" &&
                          prior.machineId === event.machineId &&
                          prior.method === "GET" &&
                          /\/machines\/[^/]+$/.test(prior.path) &&
                          prior.status === 200,
                      ),
                  ).toBe(true);
                  expect(
                    before.some(
                      (ready, readyIndex) =>
                        ready.stage === "completed" &&
                        ready.method === "GET" &&
                        ready.status === 200 &&
                        ready.machineId !== event.machineId &&
                        createdIds.has(ready.machineId) &&
                        ready.state === "started" &&
                        ready.cordoned === false &&
                        ready.checks?.some(
                          (check) =>
                            check.name === "ready" &&
                            check.status === "passing",
                        ) &&
                        before
                          .slice(readyIndex + 1)
                          .some(
                            (active) =>
                              active.stage === "completed" &&
                              active.machineId === ready.machineId &&
                              active.method === "PUT" &&
                              active.phase === "active" &&
                              active.status! < 300,
                          ),
                    ),
                  ).toBe(true);
                }
              }
              const live = yield* census(app.appName);
              expect(live.length).toBe(1);
              expect(
                live.every(
                  (machine) =>
                    successfulIds.includes(machine.id!) &&
                    machine.state === "started" &&
                    machine.cordoned === false &&
                    machine.checks?.some(
                      (check) =>
                        check.name === "ready" && check.status === "passing",
                    ) &&
                    machine.config?.metadata?.["alchemy.fqn"] ===
                      owner?.["alchemy.fqn"] &&
                    machine.config?.metadata?.["alchemy.instance"] ===
                      owner?.["alchemy.instance"],
                ),
              ).toBe(true);
              yield* assertCommitted(
                app.appName,
                live.map((machine) => machine.id!),
              );
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  firstProxy.clear();
                  firstProxy.release();
                }),
              ),
              Effect.scoped,
            );
            yield* stack.destroy();
            yield* assertAppGone(app.appName);
          }).pipe(Effect.scoped),
        { timeout: 300_000 },
      );
    });
  },
);

describe.sequential(
  "create faults",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    test.provider(
      "F02 lost completed create reuses the same owned name and real Conflict",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({
              match: (event) =>
                event.method === "POST" && event.path.endsWith("/machines"),
              action: "drop-response",
              remaining: 1,
            });
          });
          try {
            const next = yield* deployWorker(stack, "two");
            const created = proxy.events.filter(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith("/machines") &&
                event.status! < 300,
            );
            expect(created).toHaveLength(1);
            expect(next.machineIds).toEqual([created[0]!.machineId]);
            expect(next.machineId).not.toBe(initial.machineId);
            expect(
              proxy.events.filter((event) => event.stage === "dropped"),
            ).toHaveLength(1);
            const live = yield* assertCommitted(next.appName, next.machineIds);
            const conflict = yield* machines
              .createMachine({
                app_name: next.appName,
                name: live[0]!.name,
                region: live[0]!.region,
                config: live[0]!.config,
              })
              .pipe(Retry.none, Effect.result);
            expect(Result.isFailure(conflict)).toBe(true);
            if (Result.isFailure(conflict))
              expect(conflict.failure._tag).toBe("Conflict");
            yield* assertCommitted(next.appName, next.machineIds);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 300_000 },
    );
  },
);

describe.sequential(
  "engine state",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";

    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "F07 F11 fresh engine contexts reopen real durable LocalState without recreating the App",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const proxy = yield* transportProxy();
          const firstActor = yield* engineActor(
            stack,
            "F07 F11 fresh engine contexts reopen real durable LocalState without recreating the App",
            file,
            proxy.url,
          );
          const first = yield* firstActor
            .deploy(Fly.App("Site"))
            .pipe(Effect.scoped);
          const secondActor = yield* engineActor(
            stack,
            "F07 F11 fresh engine contexts reopen real durable LocalState without recreating the App",
            file,
            proxy.url,
          );
          expect(secondActor.state).not.toBe(firstActor.state);
          const second = yield* secondActor
            .deploy(Fly.App("Site"))
            .pipe(Effect.scoped);
          expect(second.appName).toBe(first.appName);
          expect(second.appId).toBe(first.appId);
          expect(
            proxy.events.filter(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path === "/v1/apps" &&
                event.status! < 300,
            ),
          ).toHaveLength(1);
          yield* stack.destroy();
          yield* assertAppGone(first.appName);
        }).pipe(Effect.scoped),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "exec leases",
  { tags: ["provider:fly", "provider:fly:service"] },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    it.effect(
      "exec probe sanitizes failures and defects without losing interruption",
      () =>
        Effect.gen(function* () {
          const privateHeader = "fixture-private-lease-header";
          const outcome = yield* Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason(new Error(privateHeader)),
              Cause.makeDieReason({
                headers: { "fly-machine-lease-nonce": privateHeader },
              }),
              Cause.makeInterruptReason(123),
            ]),
          ).pipe(sanitizeExecFailure, Effect.exit);
          expect(Exit.isFailure(outcome)).toBe(true);
          if (Exit.isFailure(outcome)) {
            expect(outcome.cause.reasons.map((reason) => reason._tag)).toEqual([
              "Fail",
              "Die",
              "Interrupt",
            ]);
            expect(Cause.pretty(outcome.cause)).not.toContain(privateHeader);
            const interrupted = outcome.cause.reasons.find(
              Cause.isInterruptReason,
            );
            expect(interrupted?.fiberId).toBe(123);
          }
        }),
      { tags: ["unit", "local"] },
    );

    test.provider(
      "exec remains blocked during a native lease even with its nonce and succeeds after observable release",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("ExecLeaseSite");
              return yield* Fly.Machine("ExecLeaseTarget", {
                app,
                region: "iad",
                image: "nginx:alpine",
                guest: { cpus: 1, memoryMb: 256 },
                checks,
                deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
                shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
              });
            }),
          );
          const target = {
            app_name: created.appName,
            machine_id: created.machineId,
          };
          const command = ["/bin/sh", "-c", "printf lease-exec-ok"];
          yield* Effect.gen(function* () {
            const leases = yield* makeMachineLeases(created.appName);
            yield* leases.acquire([created.machineId]);
            yield* leases.guard(
              Effect.gen(function* () {
                const verifyAuthority = Effect.gen(function* () {
                  const current = yield* machines
                    .getMachineLease(target)
                    .pipe(Retry.none, Effect.timeout("15 seconds"));
                  const nonce = current.data?.nonce;
                  if (!nonce)
                    return yield* Effect.fail(
                      new Error("Owned Machine lease response has no nonce"),
                    );
                  expect(
                    nonce === (yield* leases.nonceIfHeld(created.machineId)),
                  ).toBe(true);
                  expect(current.data?.expires_at).toBeGreaterThan(
                    (yield* Clock.currentTimeMillis) / 1000 + 15,
                  );
                  return nonce;
                });
                const client = yield* HttpClient.HttpClient;
                for (const header of ["held", "missing", "wrong"] as const) {
                  const nonce = yield* verifyAuthority;
                  const value =
                    header === "held"
                      ? nonce
                      : `${nonce[0] === "a" ? "b" : "a"}${nonce.slice(1)}`;
                  let observed = false;
                  // Probe the general lease header without advertising unsupported exec authorization.
                  const probeClient = HttpClient.mapRequest(
                    client,
                    (request) =>
                      header === "missing"
                        ? request
                        : HttpClientRequest.setHeader(
                            request,
                            "fly-machine-lease-nonce",
                            value,
                          ),
                  ).pipe(
                    HttpClient.tapRequest((request) =>
                      Effect.sync(() => {
                        observed = true;
                        expect(
                          request.headers["fly-machine-lease-nonce"] ===
                            (header === "missing" ? undefined : value),
                        ).toBe(true);
                      }),
                    ),
                  );
                  const outcome = yield* machines
                    .execMachine({
                      ...target,
                      command,
                      timeout: 5,
                    })
                    .pipe(
                      Retry.none,
                      Effect.timeout("15 seconds"),
                      Effect.provideService(HttpClient.HttpClient, probeClient),
                      Effect.as("accepted" as const),
                      Effect.catchTag("Conflict", () =>
                        Effect.succeed("Conflict" as const),
                      ),
                    );
                  expect(observed).toBe(true);
                  expect(outcome).toBe("Conflict");
                  yield* verifyAuthority;
                }
              }).pipe(Effect.timeout("90 seconds")),
            );
          }).pipe(Effect.scoped);

          const released = yield* machines.getMachineLease(target).pipe(
            Retry.none,
            Effect.timeout("15 seconds"),
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          );
          expect(released).toBe(true);
          expect((yield* machines.getMachine(target)).state).toBe("started");
          const unleased = yield* machines
            .execMachine({
              ...target,
              command,
              timeout: 5,
            })
            .pipe(Retry.none, Effect.timeout("15 seconds"));
          expect(unleased.exit_code).toBe(0);
          expect(unleased.stdout).toBe("lease-exec-ok");
          yield* stack.destroy();
          yield* assertAppGone(created.appName);
        }).pipe(sanitizeExecFailure),
      {
        tags: ["provider:fly:app", "provider:fly:machine", "live"],
        timeout: 300_000,
      },
    );
  },
);

describe.sequential(
  "failures",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "F01 a rejected candidate create preserves the active generation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (image: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  image,
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "30 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                  checks: {
                    ready: {
                      type: "http",
                      port: 80,
                      path: "/",
                      interval: "2s",
                      timeout: "1s",
                    },
                  },
                });
              }),
            );
          const initial = yield* deploy("nginx:alpine");
          const failed = yield* deploy(
            "nginx:alchemy-bluegreen-nonexistent-image",
          ).pipe(Effect.result);
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed))
            expect(failed.failure).toMatchObject({ _tag: "BadRequest" });
          const live = (yield* machines.listMachines({
            app_name: initial.appName,
          })).filter((machine) => machine.state !== "destroyed");
          expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
          expect(live[0]?.state).toBe("started");
          expect(live[0]?.cordoned).toBe(false);
          expect(live[0]?.config?.metadata?.["alchemy.phase"]).toBe("active");
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "health",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    for (const kind of ["named", "multiple published services"] as const) {
      test.provider(
        `S03 every ${kind} check must pass before blue retirement`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const initial = yield* deployWorker(stack, "one", {
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
            });
            const extra = { ...checks.ready, path: "/does-not-exist" };
            const failed = yield* deployWorker(stack, "two", {
              checks:
                kind === "named"
                  ? { ready: checks.ready, dependency: extra }
                  : checks,
              services:
                kind === "named"
                  ? undefined
                  : [
                      {
                        protocol: "tcp",
                        internalPort: 80,
                        ports: [{ port: 80, handlers: ["http"] }],
                        checks: [checks.ready],
                      },
                      {
                        protocol: "tcp",
                        internalPort: 80,
                        ports: [{ port: 443, handlers: ["tls", "http"] }],
                        checks: [extra],
                      },
                    ],
              deploy: { strategy: "bluegreen", healthTimeout: "8 seconds" },
            }).pipe(Effect.result);
            expect(Result.isFailure(failed)).toBe(true);
            if (Result.isFailure(failed))
              expect(failed.failure).toMatchObject({
                _tag: "Fly.ReplicaChecksNotPassing",
              });
            const live = yield* census(initial.appName);
            expect(live.map((machine) => machine.id)).toEqual(
              initial.machineIds,
            );
            expect(live[0]!.cordoned).toBe(false);
            const fixed = yield* deployWorker(stack, "two", {
              checks: { ready: checks.ready, dependency: checks.ready },
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
            });
            const committed = yield* assertCommitted(
              initial.appName,
              fixed.machineIds,
            );
            // Active commit metadata can reset reports after readiness validation.
            const healthy = yield* waitHealthy(
              initial.appName,
              committed[0]!,
              30_000,
            );
            expect(healthy.instance_id).toBe(committed[0]!.instance_id);
            expect(
              ["ready", "dependency"].every((name) =>
                healthy.checks?.some(
                  (check) => check.name === name && check.status === "passing",
                ),
              ),
            ).toBe(true);
            yield* stack.destroy();
            yield* assertAppGone(initial.appName);
          }),
        { timeout: 300_000 },
      );
    }
  },
);

describe.sequential(
  "health transport faults",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    test.provider(
      "S07 health polling recovers a lost real GET and exhausts a persistent connection cut",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one", {
            deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
          });
          const observed = yield* machines.getMachine({
            app_name: initial.appName,
            machine_id: initial.machineId,
          });
          const proxy = yield* transportProxy();
          const match = (event: { method: string; path: string }) =>
            event.method === "GET" &&
            event.path.endsWith(`/machines/${initial.machineId}`);
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({ match, action: "drop-response", remaining: 1 });
          });
          try {
            const healthy = yield* waitHealthy(
              initial.appName,
              observed,
              30_000,
              observed.config!,
            );
            expect(healthy.id).toBe(initial.machineId);
            expect(healthy.instance_id).toBe(observed.instance_id);
            expect(
              healthy.checks?.every((check) => check.status === "passing"),
            ).toBe(true);
            expect(
              proxy.events.filter(
                (event) => event.stage === "dropped" && event.status === 200,
              ),
            ).toHaveLength(1);
            yield* Effect.sync(() =>
              proxy.arm({ match, action: "cut-request", remaining: Infinity }),
            );
            let attempts = 0;
            const client = yield* HttpClient.HttpClient;
            const observedClient = HttpClient.tapRequest(client, (request) =>
              Effect.sync(() => {
                if (
                  request.method === "GET" &&
                  request.url.endsWith(`/machines/${initial.machineId}`)
                ) {
                  attempts++;
                }
              }),
            );
            const started = yield* Clock.currentTimeMillis;
            const failed = yield* waitHealthy(
              initial.appName,
              healthy,
              8_000,
              healthy.config!,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, observedClient),
              Effect.result,
            );
            expect(
              (yield* Clock.currentTimeMillis) - started,
            ).toBeLessThanOrEqual(12_000);
            expect(Result.isFailure(failed)).toBe(true);
            if (Result.isFailure(failed)) {
              expect(failed.failure).toMatchObject({
                _tag: "Fly.ReplicaChecksNotPassing",
                appName: initial.appName,
                machineId: initial.machineId,
              });
            }
            expect(
              proxy.events.filter((event) => event.stage === "cut").length,
            ).toBeGreaterThan(0);
            // Count logical client calls independently of Bun's physical GET retries.
            expect(attempts).toBeGreaterThan(0);
            expect(attempts).toBeLessThanOrEqual(11);
            const live = yield* census(initial.appName);
            expect(live.map((machine) => machine.id)).toEqual(
              initial.machineIds,
            );
            expect(live[0]!.cordoned).toBe(false);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "health deadlines",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    for (const budget of [8_000, 90_000]) {
      test.provider(
        `S06 real delayed readiness beyond the default minute with ${budget}ms budget`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const initial = yield* deployWorker(stack, "one");
            const result = yield* deployWorker(stack, "two", {
              init: {
                exec: [
                  "/bin/sh",
                  "-c",
                  "sleep 65; exec nginx -g 'daemon off;'",
                ],
              },
              checks: { ready: { ...checks.ready, gracePeriod: "65s" } },
              deploy: { strategy: "bluegreen", healthTimeout: budget },
            }).pipe(Effect.result);
            if (budget === 8_000) {
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect(result.failure).toMatchObject({
                  _tag: "Fly.ReplicaChecksNotPassing",
                });
              const live = yield* census(initial.appName);
              expect(live.map((machine) => machine.id)).toEqual(
                initial.machineIds,
              );
              expect(live[0]!.cordoned).toBe(false);
            } else {
              expect(Result.isSuccess(result)).toBe(true);
              if (Result.isSuccess(result)) {
                expect(result.success.machineId).not.toBe(initial.machineId);
                yield* assertCommitted(
                  initial.appName,
                  result.success.machineIds,
                );
              }
            }
            yield* stack.destroy();
            yield* assertAppGone(initial.appName);
          }),
        { timeout: 600_000 },
      );
    }
  },
);

describe.sequential(
  "idle capacity",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    describe.sequential("idle topology", () => {
      for (const mode of ["stop", "suspend"] as const) {
        for (const allIdle of [false, true]) {
          test.provider(
            `S05 S11 ${mode} ${allIdle ? "all-idle" : "mixed"} replacement keeps an idle nonrepresentative`,
            (stack) =>
              Effect.gen(function* () {
                yield* stack.destroy();
                const props = {
                  count: 2,
                  services: [
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop: mode,
                      autostart: true,
                      minMachinesRunning: 0,
                      ports: [{ port: 80, handlers: ["http"] }],
                      checks: [checks.ready],
                    },
                  ],
                };
                const initial = yield* deployWorker(stack, "one", {
                  ...props,
                  deploy: { strategy: "rolling" },
                });
                for (const id of allIdle
                  ? initial.machineIds
                  : initial.machineIds.slice(1)) {
                  const target = { app_name: initial.appName, machine_id: id };
                  yield* mode === "stop"
                    ? machines.stopMachine({
                        ...target,
                        signal: "SIGQUIT",
                        timeout: "5s",
                      })
                    : machines.suspendMachine(target);
                  const observed = yield* machines.getMachine(target).pipe(
                    Effect.repeat({
                      schedule: Schedule.spaced("2 seconds"),
                      times: 8,
                      until: (machine) =>
                        machine.state ===
                        (mode === "stop" ? "stopped" : "suspended"),
                    }),
                  );
                  expect(observed.state).toBe(
                    mode === "stop" ? "stopped" : "suspended",
                  );
                }
                const proxy = yield* transportProxy();
                yield* Effect.sync(() => {
                  endpoint = proxy.url;
                });
                const next = yield* deployWorker(stack, "two", props);
                expect(next.machineIds).toHaveLength(2);
                const live = yield* census(initial.appName);
                expect(live.map((machine) => machine.id).sort()).toEqual(
                  [...next.machineIds].sort(),
                );
                expect(
                  live.every((machine) => {
                    const autostop = machine.config?.services?.[0]?.autostop;
                    return (autostop === true ? "stop" : autostop) === mode;
                  }),
                ).toBe(true);
                expect(
                  live.filter((machine) => machine.state === "started").length,
                ).toBeLessThanOrEqual(1);
                expect(
                  live.some((machine) =>
                    ["stopped", "suspended"].includes(machine.state!),
                  ),
                ).toBe(true);
                expect(
                  proxy.events.some(
                    (event) =>
                      initial.machineIds.includes(event.machineId!) &&
                      event.path.endsWith("/start"),
                  ),
                ).toBe(false);
                const same = yield* deployWorker(stack, "two", props);
                expect(same.machineIds).toEqual(next.machineIds);
                yield* Effect.sync(() => {
                  endpoint = undefined;
                });
                yield* stack.destroy();
                yield* assertAppGone(initial.appName);
              }).pipe(
                Effect.scoped,
                Effect.ensuring(
                  Effect.sync(() => {
                    endpoint = undefined;
                  }),
                ),
              ),
            { timeout: 300_000 },
          );
        }
      }
    });
  },
);

describe.sequential(
  "idle topology",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    const { test } = Test.make({ providers: Fly.providers() });
    type IdleMode = "stop" | "suspend";

    const topology = (
      mode: IdleMode,
      count: number,
      floor = 0,
      mixed = false,
    ): Partial<Omit<Extract<MachineProps, { image: string }>, "app">> => ({
      count,
      deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
      services: [
        {
          protocol: "tcp",
          internalPort: 80,
          autostop: mode,
          autostart: true,
          minMachinesRunning: floor,
          checks: [checks.ready],
        },
        ...(mixed
          ? [{ protocol: "tcp", internalPort: 81, autostop: "off" as const }]
          : []),
      ],
    });

    const waitState = (appName: string, machineId: string, state: string) =>
      machines.getMachine({ app_name: appName, machine_id: machineId }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
          until: (machine) => machine.state === state,
        }),
        Effect.tap((machine) =>
          Effect.sync(() => expect(machine.state).toBe(state)),
        ),
        Effect.timeout("90 seconds"),
      );

    // Native stop/suspend is setup only; automatic return-to-idle has its own test.
    const idleAll = (appName: string, ids: string[], mode: IdleMode) =>
      Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const target = { app_name: appName, machine_id: id };
          const current = yield* machines.getMachine(target);
          if (current.state !== "started") {
            yield* machines.startMachine(target);
            yield* waitState(appName, id, "started");
          }
          if (mode === "stop") {
            yield* machines.stopMachine({
              ...target,
              signal: "SIGQUIT",
              timeout: "5s",
            });
          } else {
            yield* machines.suspendMachine(target);
          }
          yield* waitState(
            appName,
            id,
            mode === "stop" ? "stopped" : "suspended",
          );
        }),
      );

    // Expected slots are literal scenario inputs, never computed by readinessRoles.
    const assertSlots = (
      live: machines.Machine[],
      runningSlots: readonly number[],
    ) => {
      const ordered = [...live].sort(
        (left, right) =>
          Number(left.config?.metadata?.["alchemy.replica"]) -
          Number(right.config?.metadata?.["alchemy.replica"]),
      );
      expect(
        ordered.map((machine) => machine.config?.metadata?.["alchemy.replica"]),
      ).toEqual(
        Array.from({ length: live.length }, (_, index) => String(index)),
      );
      expect(
        ordered
          .filter(
            (machine) =>
              machine.config?.metadata?.["alchemy.readiness-role"] === "run",
          )
          .map((machine) =>
            Number(machine.config?.metadata?.["alchemy.replica"]),
          ),
      ).toEqual([...runningSlots]);
      const roles = Array.from({ length: live.length }, (_, slot) =>
        runningSlots.includes(slot) ? "run" : "idle",
      ).join(",");
      for (const [slot, machine] of ordered.entries()) {
        expect(machine.config?.metadata?.["alchemy.readiness-role"]).toBe(
          runningSlots.includes(slot) ? "run" : "idle",
        );
        expect(machine.config?.metadata?.["alchemy.readiness-roles"]).toBe(
          roles,
        );
      }
      return ordered;
    };

    const assertTopology = (
      appName: string,
      ids: string[],
      mode: IdleMode,
      runningSlots: readonly number[],
      floor = 0,
      mixed = false,
    ) =>
      Effect.gen(function* () {
        const live = yield* assertCommitted(appName, ids);
        const ordered = assertSlots(live, runningSlots);
        expect(
          new Set(
            live.map(
              (machine) => machine.config?.metadata?.["alchemy.generation"],
            ),
          ).size,
        ).toBe(1);
        for (const [slot, machine] of ordered.entries()) {
          expect(
            machine.config?.metadata?.["alchemy.idle-policy-restored"],
          ).toBe("true");
          expect(machine.cordoned).toBe(false);
          expect(machine.config?.services).toHaveLength(mixed ? 2 : 1);
          expect(autostopMode(machine.config?.services?.[0]?.autostop)).toBe(
            mode,
          );
          expect(machine.config?.services?.[0]?.autostart).toBe(true);
          expect(machine.config?.services?.[0]?.min_machines_running).toBe(
            floor,
          );
          if (mixed) {
            expect(autostopMode(machine.config?.services?.[1]?.autostop)).toBe(
              "off",
            );
          }
          if (!runningSlots.includes(slot)) {
            expect(["created", "stopped", "suspended"]).toContain(
              machine.state,
            );
          } else {
            expect(
              mixed ? ["started"] : ["started", "stopped", "suspended"],
            ).toContain(machine.state);
            expect(machine.instance_id).toBeDefined();
            expect(machine.config?.metadata?.["alchemy.checked-instance"]).toBe(
              machine.instance_id,
            );
          }
        }
        return ordered;
      });

    const checkedDeployment = (
      actor: Test.ScratchStack,
      proxy: { events: TransportEvent[]; readiness: ReadinessEvent[] },
      version: string,
      mode: IdleMode,
      count: number,
      runningSlots: readonly number[],
      priorIds: readonly string[] = [],
      floor = 0,
      mixed = false,
    ) =>
      Effect.gen(function* () {
        const begin = proxy.events.length;
        const proofBegin = proxy.readiness.length;
        const output = yield* deployWorker(
          actor,
          version,
          topology(mode, count, floor, mixed),
        ).pipe(Effect.scoped);
        const live = yield* assertTopology(
          output.appName,
          output.machineIds,
          mode,
          runningSlots,
          floor,
          mixed,
        );
        assertReadinessCommit(
          proxy.readiness.slice(proofBegin),
          priorIds,
          live,
          runningSlots,
          ["ready", "servicecheck-00-http-80"],
          !mixed,
        );
        expect(
          proxy.events
            .slice(begin)
            .some(
              (event) =>
                event.stage === "request" &&
                priorIds.includes(event.machineId!) &&
                event.path.endsWith("/start"),
            ),
        ).toBe(false);
        return output;
      });

    describe.sequential("live idle topology and automatic cadence", () => {
      for (const mode of ["stop", "suspend"] as const) {
        test.provider(
          `S05 S11 F13 ${mode} real all-idle 1 to 3 to 1 scaling preserves representative-only readiness`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const site = yield* stack.deploy(Fly.App("Site"));
              try {
                const proxy = yield* readinessProxy();
                const actor = yield* readinessActor(
                  stack,
                  `S05 S11 F13 ${mode} real all-idle 1 to 3 to 1 scaling preserves representative-only readiness`,
                  file,
                  proxy,
                );
                const first = yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  1,
                  [0],
                );
                yield* idleAll(site.appName, first.machineIds, mode);
                const up = yield* checkedDeployment(
                  actor,
                  proxy,
                  "two",
                  mode,
                  3,
                  [0],
                  first.machineIds,
                );
                expect(up.machineIds).toHaveLength(3);
                expect(
                  up.machineIds.every((id) => !first.machineIds.includes(id)),
                ).toBe(true);
                yield* idleAll(site.appName, up.machineIds, mode);
                const down = yield* checkedDeployment(
                  actor,
                  proxy,
                  "three",
                  mode,
                  1,
                  [0],
                  up.machineIds,
                );
                expect(down.machineIds).toHaveLength(1);
                expect(up.machineIds).not.toContain(down.machineId);
                yield* idleAll(site.appName, down.machineIds, mode);
                const unchanged = yield* deployWorker(
                  actor,
                  "three",
                  topology(mode, 1),
                );
                expect(unchanged.machineIds).toEqual(down.machineIds);
                expect((yield* census(site.appName))[0]!.state).toBe(
                  mode === "stop" ? "stopped" : "suspended",
                );
              } finally {
                yield* stack.destroy();
                yield* assertAppGone(site.appName);
              }
            }).pipe(Effect.scoped),
          { timeout: 900_000 },
        );

        test.provider(
          `S05 S11 F13 ${mode} live floor 0 to 2 to 0 and mixed off-plus-idle service topology`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const site = yield* stack.deploy(Fly.App("Site"));
              try {
                const proxy = yield* readinessProxy();
                const actor = yield* readinessActor(
                  stack,
                  `S05 S11 F13 ${mode} live floor 0 to 2 to 0 and mixed off-plus-idle service topology`,
                  file,
                  proxy,
                );
                const first = yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  3,
                  [0],
                );
                yield* idleAll(site.appName, first.machineIds, mode);
                const raised = yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  3,
                  [0, 1],
                  first.machineIds,
                  2,
                );
                yield* idleAll(site.appName, raised.machineIds, mode);
                const lowered = yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  3,
                  [0],
                  raised.machineIds,
                );
                yield* idleAll(site.appName, lowered.machineIds, mode);
                const slots = assertSlots(yield* census(site.appName), [0]);
                yield* machines.startMachine({
                  app_name: site.appName,
                  machine_id: slots[2]!.id!,
                });
                yield* waitState(site.appName, slots[2]!.id!, "started");
                const mixedOld = (yield* census(site.appName)).sort(
                  (a, b) =>
                    Number(a.config?.metadata?.["alchemy.replica"]) -
                    Number(b.config?.metadata?.["alchemy.replica"]),
                );
                expect(mixedOld.map((machine) => machine.state)).toEqual([
                  mode === "stop" ? "stopped" : "suspended",
                  mode === "stop" ? "stopped" : "suspended",
                  "started",
                ]);
                const retained = yield* checkedDeployment(
                  actor,
                  proxy,
                  "retained",
                  mode,
                  3,
                  [2],
                  lowered.machineIds,
                );
                yield* idleAll(site.appName, retained.machineIds, mode);
                const retainedSlots = assertSlots(
                  yield* census(site.appName),
                  [2],
                );
                yield* machines.startMachine({
                  app_name: site.appName,
                  machine_id: retainedSlots[2]!.id!,
                });
                yield* waitState(
                  site.appName,
                  retainedSlots[2]!.id!,
                  "started",
                );
                expect(
                  assertSlots(yield* census(site.appName), [2]).map(
                    (machine) => machine.state,
                  ),
                ).toEqual([
                  mode === "stop" ? "stopped" : "suspended",
                  mode === "stop" ? "stopped" : "suspended",
                  "started",
                ]);
                const retainedFloor = yield* checkedDeployment(
                  actor,
                  proxy,
                  "retained",
                  mode,
                  3,
                  [0, 2],
                  retained.machineIds,
                  2,
                );
                yield* idleAll(site.appName, retainedFloor.machineIds, mode);
                const mixed = yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  3,
                  [0, 1, 2],
                  retainedFloor.machineIds,
                  0,
                  true,
                );
                yield* idleAll(site.appName, mixed.machineIds, mode);
                yield* checkedDeployment(
                  actor,
                  proxy,
                  "one",
                  mode,
                  3,
                  [0],
                  mixed.machineIds,
                );
              } finally {
                yield* stack.destroy();
                yield* assertAppGone(site.appName);
              }
            }).pipe(Effect.scoped),
          { timeout: 1_200_000 },
        );

        for (const recoveredCount of [3, 1, 4]) {
          test.provider(
            `S05 S11 F08 F13 ${mode} interrupted partial idle restoration recovers count 3 to ${recoveredCount}`,
            (stack) =>
              Effect.gen(function* () {
                yield* stack.destroy();
                const site = yield* stack.deploy(Fly.App("Site"));
                try {
                  const proxy = yield* readinessProxy();
                  const initial = yield* readinessActor(
                    stack,
                    `S05 S11 F08 F13 ${mode} interrupted partial idle restoration recovers count 3 to ${recoveredCount}`,
                    file,
                    proxy,
                  );
                  const first = yield* checkedDeployment(
                    initial,
                    proxy,
                    "one",
                    mode,
                    3,
                    [0],
                  );
                  yield* idleAll(site.appName, first.machineIds, mode);
                  const source = (yield* census(site.appName))[0]!;
                  const metadata = source.config!.metadata!;
                  const attemptBegin = proxy.events.length;
                  yield* Effect.gen(function* () {
                    try {
                      const gate = yield* Deferred.make<string>();
                      const actor = yield* readinessActor(
                        stack,
                        `S05 S11 F08 F13 ${mode} interrupted partial idle restoration recovers count 3 to ${recoveredCount}`,
                        file,
                        proxy,
                        (event) =>
                          event.method === "POST" &&
                          event.path ===
                            `/v1/apps/${site.appName}/machines/${event.machineId}` &&
                          event.metadata?.["alchemy.replica"] === "1" &&
                          event.metadata["alchemy.fqn"] ===
                            metadata["alchemy.fqn"] &&
                          event.metadata["alchemy.generation"] !==
                            metadata["alchemy.generation"] &&
                          event.metadata["alchemy.readiness-roles"] ===
                            "run,run,idle" &&
                          event.metadata["alchemy.idle-policy-restored"] ===
                            "true" &&
                          event.phase === "promoting"
                            ? Deferred.succeed(gate, event.machineId!).pipe(
                                Effect.andThen(Effect.never),
                              )
                            : Effect.void,
                      );
                      const attempt = yield* deployWorker(
                        actor,
                        "two",
                        topology(mode, 3, 2),
                      ).pipe(Effect.scoped, Effect.forkScoped);
                      const barrierMachine = yield* Deferred.await(gate).pipe(
                        Effect.timeout("180 seconds"),
                      );
                      const pending = yield* census(site.appName);
                      expect(
                        pending.filter((machine) =>
                          first.machineIds.includes(machine.id!),
                        ),
                      ).toHaveLength(3);
                      expect(
                        proxy.events.some((event) =>
                          retires(event, first.machineIds),
                        ),
                      ).toBe(false);
                      const candidates = yield* Effect.forEach(
                        pending.filter(
                          (machine) => !first.machineIds.includes(machine.id!),
                        ),
                        (machine) =>
                          machines.getMachine({
                            app_name: site.appName,
                            machine_id: machine.id!,
                          }),
                      );
                      expect(candidates).toHaveLength(3);
                      expect(
                        candidates.every(
                          (machine) =>
                            machine.config?.metadata?.["alchemy.phase"] ===
                            "promoting",
                        ),
                      ).toBe(true);
                      const pendingSlots = assertSlots(candidates, [0, 1]);
                      expect(
                        pendingSlots[0]!.config?.metadata?.[
                          "alchemy.idle-policy-restored"
                        ],
                      ).toBe("true");
                      expect(
                        pendingSlots[1]!.config?.metadata?.[
                          "alchemy.idle-policy-restored"
                        ],
                      ).toBe("false");
                      expect(
                        proxy.readiness.some(
                          (event) =>
                            event.stage === "forwarded" &&
                            event.method === "GET" &&
                            event.machineId === pendingSlots[0]!.id &&
                            event.instanceId === pendingSlots[0]!.instance_id &&
                            event.metadata?.["alchemy.idle-policy-restored"] ===
                              "true" &&
                            event.phase === "promoting" &&
                            event.state === "started" &&
                            readinessChecksPassing(event.checks, [
                              "ready",
                              "servicecheck-00-http-80",
                            ]),
                        ),
                      ).toBe(true);
                      expect(barrierMachine).toBe(pendingSlots[1]!.id);
                      expect(
                        autostopMode(
                          pendingSlots[0]!.config?.services?.[0]?.autostop,
                        ),
                      ).toBe(mode);
                      expect(
                        autostopMode(
                          pendingSlots[1]!.config?.services?.[0]?.autostop,
                        ),
                      ).toBe("off");
                      expect(
                        proxy.events
                          .slice(attemptBegin)
                          .some(
                            (event) =>
                              event.method === "POST" &&
                              event.path.endsWith(
                                `/machines/${barrierMachine}`,
                              ) &&
                              event.phase === "promoting",
                          ),
                      ).toBe(false);
                      const read = yield* observeReplicaSet({
                        appName: site.appName,
                        id: "Worker",
                        type: "Fly.Machine",
                        fqn: metadata["alchemy.fqn"]!,
                        resourceInstanceId: metadata["alchemy.instance"]!,
                        baseName: first.baseName,
                        machineIds: first.machineIds,
                      });
                      expect(read?.machineIds).toEqual(first.machineIds);
                      expect(read?.count).toBe(3);
                      expect(read?.rolloutPending).toBe(true);
                      const interruption = yield* Fiber.interrupt(attempt).pipe(
                        Effect.forkScoped,
                      );
                      yield* Effect.yieldNow;
                      yield* Effect.sync(() => {
                        proxy.clear();
                        proxy.release();
                      });
                      yield* Fiber.join(interruption).pipe(
                        Effect.timeout("180 seconds"),
                      );
                      expect(
                        Exit.hasInterrupts(yield* Fiber.await(attempt)),
                      ).toBe(true);
                      expect(
                        proxy.events
                          .slice(attemptBegin)
                          .some(
                            (event) =>
                              first.machineIds.includes(event.machineId!) &&
                              event.path.endsWith("/start"),
                          ),
                      ).toBe(false);
                      expect(
                        proxy.readiness.some(
                          (event) =>
                            event.stage === "request" &&
                            event.path.endsWith("/metadata") &&
                            event.phase === "active" &&
                            candidates.some(
                              (machine) => machine.id === event.machineId,
                            ),
                        ),
                      ).toBe(false);
                      expect(
                        proxy.events.some((event) =>
                          retires(event, first.machineIds),
                        ),
                      ).toBe(false);
                      const resumed = yield* readinessActor(
                        stack,
                        `S05 S11 F08 F13 ${mode} interrupted partial idle restoration recovers count 3 to ${recoveredCount}`,
                        file,
                        proxy,
                      );
                      const begin = proxy.readiness.length;
                      const recovered = yield* deployWorker(
                        resumed,
                        "two",
                        topology(mode, recoveredCount, 2),
                      ).pipe(Effect.scoped);
                      expect(recovered.machineIds).toHaveLength(recoveredCount);
                      if (recoveredCount === 3) {
                        expect([...recovered.machineIds].sort()).toEqual(
                          candidates.map((machine) => machine.id).sort(),
                        );
                      } else {
                        expect(
                          recovered.machineIds.every(
                            (id) =>
                              !pending.some((machine) => machine.id === id),
                          ),
                        ).toBe(true);
                      }
                      const runningSlots = recoveredCount === 1 ? [0] : [0, 1];
                      const live = yield* assertTopology(
                        site.appName,
                        recovered.machineIds,
                        mode,
                        runningSlots,
                        2,
                      );
                      assertReadinessCommit(
                        proxy.readiness.slice(begin),
                        pending
                          .map((machine) => machine.id!)
                          .filter((id) => !recovered.machineIds.includes(id)),
                        live,
                        runningSlots,
                        ["ready", "servicecheck-00-http-80"],
                        true,
                      );
                      const unchanged = yield* deployWorker(
                        resumed,
                        "two",
                        topology(mode, recoveredCount, 2),
                      ).pipe(Effect.scoped);
                      expect(unchanged.machineIds).toEqual(
                        recovered.machineIds,
                      );
                      const committed = yield* observeReplicaSet({
                        appName: site.appName,
                        id: "Worker",
                        type: "Fly.Machine",
                        fqn: metadata["alchemy.fqn"]!,
                        resourceInstanceId: metadata["alchemy.instance"]!,
                        machineIds: recovered.machineIds,
                      });
                      expect(committed?.rolloutPending).toBe(false);
                      expect(committed?.machineIds).toEqual(
                        recovered.machineIds,
                      );
                    } finally {
                      yield* Effect.sync(() => {
                        proxy.clear();
                        proxy.release();
                      });
                    }
                  }).pipe(Effect.scoped);
                } finally {
                  yield* stack.destroy();
                  yield* assertAppGone(site.appName);
                }
              }).pipe(Effect.scoped),
            { timeout: 900_000 },
          );
        }

        test.provider(
          `S11 public traffic autostarts ${mode} and Fly automatically returns it to idle within 15 minutes`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const site = yield* stack.deploy(Fly.App("Site"));
              try {
                const output = yield* stack.deploy(
                  Effect.gen(function* () {
                    const app = yield* Fly.App("Site");
                    yield* Fly.IpAssignment("Public", {
                      app,
                      type: "shared_v4",
                    });
                    return yield* Fly.Machine("Worker", {
                      app,
                      image: "nginx:alpine",
                      deploy: {
                        strategy: "bluegreen",
                        healthTimeout: "60 seconds",
                      },
                      shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                      services: [
                        {
                          protocol: "tcp",
                          internalPort: 80,
                          autostop: mode,
                          autostart: true,
                          minMachinesRunning: 0,
                          ports: [{ port: 80, handlers: ["http"] }],
                          checks: [checks.ready],
                        },
                      ],
                    });
                  }),
                );
                yield* idleAll(site.appName, output.machineIds, mode);
                const client = yield* HttpClient.HttpClient;
                yield* Effect.gen(function* () {
                  const response = yield* client.get(
                    `http://${site.appName}.fly.dev`,
                  );
                  const body = yield* response.text;
                  if (
                    response.status !== 200 ||
                    !body.includes("Welcome to nginx")
                  ) {
                    return yield* Effect.fail(
                      new Error(
                        `Public Fly route is not ready: ${response.status}`,
                      ),
                    );
                  }
                  expect(response.status).toBe(200);
                  expect(body).toContain("Welcome to nginx");
                }).pipe(
                  Effect.retry({
                    schedule: Schedule.spaced("3 seconds"),
                    times: 20,
                  }),
                  Effect.timeout("90 seconds"),
                );
                yield* waitState(site.appName, output.machineId, "started");
                const started = yield* Clock.currentTimeMillis;
                const idleState = mode === "stop" ? "stopped" : "suspended";
                // Only native GETs follow the last public request; no stop, suspend, or update substitutes.
                const idle = yield* machines
                  .getMachine({
                    app_name: site.appName,
                    machine_id: output.machineId,
                  })
                  .pipe(
                    Effect.tap((machine) =>
                      Effect.logInfo("Automatic Fly idle observation", {
                        mode,
                        state: machine.state,
                        instanceId: machine.instance_id,
                      }),
                    ),
                    Effect.repeat({
                      schedule: Schedule.spaced("10 seconds"),
                      times: 90,
                      until: (machine) => machine.state === idleState,
                    }),
                    Effect.timeout("15 minutes"),
                  );
                expect(idle.state).toBe(idleState);
                expect(idle.cordoned).toBe(false);
                expect(autostopMode(idle.config?.services?.[0]?.autostop)).toBe(
                  mode,
                );
                expect(
                  idle.config?.metadata?.["alchemy.idle-policy-restored"],
                ).toBe("true");
                yield* Effect.logInfo("Automatic return to idle observed", {
                  mode,
                  elapsedMs: (yield* Clock.currentTimeMillis) - started,
                });
                expect(
                  (yield* census(site.appName)).map((machine) => machine.id),
                ).toEqual(output.machineIds);
              } finally {
                yield* stack.destroy();
                yield* assertAppGone(site.appName);
              }
            }),
          { tags: ["provider:fly:ipassignment"], timeout: 1_200_000 },
        );
      }
    });
  },
);

describe.sequential(
  "image identity",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "S08 mixed real image digests and invalid recovery pin replace the complete generation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one", { count: 2 });
          const first = yield* machines.getMachine({
            app_name: initial.appName,
            machine_id: initial.machineIds[0]!,
          });
          const target = {
            app_name: initial.appName,
            machine_id: initial.machineIds[1]!,
          };
          const second = yield* machines.getMachine(target);
          yield* machines.updateMachine({
            ...target,
            config: { ...second.config, image: "nginx:1.26-alpine" },
          });
          const drifted = yield* machines.getMachine(target).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
              until: (machine) =>
                machine.state === "started" &&
                !!machine.image_ref?.digest &&
                machine.image_ref.digest !== first.image_ref?.digest,
            }),
          );
          expect(drifted.state).toBe("started");
          expect(drifted.image_ref?.digest).toBeDefined();
          expect(drifted.image_ref?.digest).not.toBe(first.image_ref?.digest);
          const repaired = yield* deployWorker(stack, "one", {
            count: 2,
            deploy: { strategy: "bluegreen", healthTimeout: "25 seconds" },
          });
          expect(
            repaired.machineIds.every((id) => !initial.machineIds.includes(id)),
          ).toBe(true);
          const live = yield* assertCommitted(
            initial.appName,
            repaired.machineIds,
          );
          expect(
            live.every((machine) =>
              machine.config?.metadata?.["alchemy.image"]?.endsWith(
                machine.image_ref!.digest!,
              ),
            ),
          ).toBe(true);
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "S08 a real Fly registry mutable-tag change after first resolution cannot split the generation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const publisher = yield* Effect.sync(() =>
            scratchStack(
              { providers: Docker.providers(), stage: stack.stage },
              `${"S08 a real Fly registry mutable-tag change after first resolution cannot split the generation"} publisher`,
              "test/Fly/BlueGreen.test.ts",
            ),
          );
          yield* publisher.destroy();
          yield* Effect.gen(function* () {
            const minted = yield* machines.createAppDeployToken({
              app_name: initial.appName,
            });
            expect(minted.token).toBeDefined();
            const publish = (tag: string) =>
              publisher.deploy(
                Docker.RemoteImage("Mutable", {
                  name: "nginx",
                  tag,
                  platform: "linux/amd64",
                  targetName: initial.appName,
                  targetTag: "acceptance-mutable",
                  registry: {
                    server: "registry.fly.io",
                    username: "x",
                    password: Redacted.make(minted.token!),
                  },
                }),
              );
            // Upload both layer sets before holding a provider call with its own bounded deadline.
            yield* publish("1.27-alpine");
            const original = yield* publish("1.26-alpine");
            expect(original.imageRef).toBe(
              `registry.fly.io/${initial.appName}:acceptance-mutable`,
            );
            const proxy = yield* transportProxy();
            yield* Effect.sync(() =>
              proxy.arm({
                match: (event) =>
                  event.method === "POST" && event.path.endsWith("/machines"),
                action: "hold-response",
                remaining: 1,
              }),
            );
            yield* Effect.gen(function* () {
              const actor = yield* engineActor(
                stack,
                "S08 a real Fly registry mutable-tag change after first resolution cannot split the generation",
                "test/Fly/BlueGreen.test.ts",
                proxy.url,
              );
              const rollout = yield* deployWorker(actor, "two", {
                image: original.imageRef,
                count: 3,
              }).pipe(Effect.scoped, Effect.forkScoped);
              const held = yield* proxy.wait(
                (event) => event.stage === "held" && event.status! < 300,
              );
              expect(held.digest).toMatch(/^sha256:/);
              const moved = yield* publish("1.27-alpine");
              expect(moved.imageRef).toBe(original.imageRef);
              expect(moved.repoDigest).toBeDefined();
              expect(moved.repoDigest).not.toBe(original.repoDigest);
              expect(
                proxy.events.filter(
                  (event) =>
                    event.stage === "request" &&
                    event.method === "POST" &&
                    event.path.endsWith("/machines"),
                ),
              ).toHaveLength(1);
              const probe = yield* machines.createMachine({
                app_name: initial.appName,
                name: "mutable-tag-probe",
                region: "iad",
                skip_launch: true,
                skip_service_registration: true,
                config: { image: moved.imageRef },
              });
              yield* Effect.gen(function* () {
                expect(probe.image_ref?.digest).toMatch(/^sha256:/);
                expect(probe.image_ref?.digest).not.toBe(held.digest);
                yield* Effect.sync(proxy.release);
                const next = yield* Fiber.join(rollout).pipe(
                  Effect.timeout("180 seconds"),
                );
                const creates = proxy.events.filter(
                  (event) =>
                    event.stage === "completed" &&
                    event.method === "POST" &&
                    event.path.endsWith("/machines") &&
                    event.status! < 300,
                );
                expect(creates).toHaveLength(3);
                expect(
                  creates.every((event) => event.digest === held.digest),
                ).toBe(true);
                expect(
                  creates
                    .slice(1)
                    .every((event) => event.image?.endsWith(`@${held.digest}`)),
                ).toBe(true);
                for (const id of next.machineIds) {
                  const machine = yield* machines.getMachine({
                    app_name: initial.appName,
                    machine_id: id,
                  });
                  expect(machine.image_ref?.digest).toBe(held.digest);
                  expect(
                    machine.config?.metadata?.["alchemy.image"]?.endsWith(
                      `@${held.digest}`,
                    ),
                  ).toBe(true);
                }
                expect(next.machineIds).toContain(held.machineId);
                expect(next.machineIds).not.toContain(initial.machineId);
              }).pipe(
                Effect.ensuring(
                  machines
                    .deleteMachine({
                      app_name: initial.appName,
                      machine_id: probe.id!,
                      force: true,
                    })
                    .pipe(
                      Effect.catchTag("NotFound", () => Effect.void),
                      Effect.orDie,
                    ),
                ),
              );
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  proxy.clear();
                  proxy.release();
                }),
              ),
              Effect.scoped,
            );
            const live = yield* machines.listMachines({
              app_name: initial.appName,
            });
            const active = live.filter(
              (machine) => machine.state !== "destroyed",
            );
            expect(active).toHaveLength(3);
            yield* assertCommitted(
              initial.appName,
              active.map((machine) => machine.id!),
            );
          }).pipe(Effect.ensuring(publisher.destroy().pipe(Effect.orDie)));
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(Effect.scoped),
      {
        tags: ["provider:docker", "provider:docker:remoteimage"],
        timeout: 600_000,
      },
    );
  },
);

describe.sequential(
  "fiber interruption",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    const { test } = Test.make({ providers: Fly.providers() });

    describe.sequential("in-process engine interruption", () => {
      for (const phase of ["create", "promotion", "retirement"] as const) {
        test.provider(
          `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 fiber interruption at a completed ${phase} response barrier`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const initial = yield* deployWorker(stack, "one");
              const proxy = yield* transportProxy();
              const match = (event: TransportEvent) =>
                phase === "create"
                  ? event.method === "POST" && event.path.endsWith("/machines")
                  : phase === "promotion"
                    ? event.path.endsWith("/uncordon")
                    : event.method === "DELETE" &&
                      /\/machines\/[^/]+$/.test(event.path) &&
                      event.machineId === initial.machineId;
              yield* Effect.sync(() =>
                proxy.arm({ match, action: "hold-response", remaining: 1 }),
              );
              yield* Effect.gen(function* () {
                const actor = yield* engineActor(
                  stack,
                  `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 fiber interruption at a completed ${phase} response barrier`,
                  file,
                  proxy.url,
                );
                const interrupted = yield* deployWorker(actor, "two").pipe(
                  Effect.scoped,
                  Effect.forkScoped,
                );
                const barrier = yield* proxy.wait(
                  (event) =>
                    event.stage === "held" &&
                    event.status! >= 200 &&
                    event.status! < 300 &&
                    match(event),
                );
                expect(barrier.machineId).toBeDefined();
                const interruption = yield* Fiber.interrupt(interrupted).pipe(
                  Effect.forkScoped,
                );
                yield* Effect.yieldNow;
                // Let accepted uninterruptible work and finalizers settle; this is not process-kill evidence.
                yield* Effect.sync(() => {
                  proxy.clear();
                  proxy.release();
                });
                yield* Fiber.join(interruption).pipe(
                  Effect.timeout("90 seconds"),
                );
                const exit = yield* Fiber.await(interrupted);
                expect(Exit.hasInterrupts(exit)).toBe(true);
                const surviving = yield* census(initial.appName);
                const green = surviving.filter(
                  (machine) => machine.id !== initial.machineId,
                );
                if (phase === "create") {
                  expect(
                    surviving.some(
                      (machine) => machine.id === initial.machineId,
                    ),
                  ).toBe(true);
                  expect(green.length).toBeLessThanOrEqual(1);
                } else {
                  expect(green).toHaveLength(1);
                  expect(green[0]!.cordoned).toBe(false);
                }
                const resumed = yield* engineActor(
                  stack,
                  `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 fiber interruption at a completed ${phase} response barrier`,
                  file,
                );
                expect(resumed.state).not.toBe(actor.state);
                const recovered = yield* deployWorker(resumed, "two").pipe(
                  Effect.scoped,
                );
                if (green.length)
                  expect(recovered.machineIds).toEqual(
                    green.map((machine) => machine.id),
                  );
                yield* assertCommitted(initial.appName, recovered.machineIds);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    proxy.clear();
                    proxy.release();
                  }),
                ),
                Effect.scoped,
              );
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(Effect.scoped),
          { timeout: 300_000 },
        );
      }
    });
  },
);

describe.sequential(
  "native leases",
  { tags: ["provider:fly", "provider:fly:service", "live"] },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    type Target = { app_name: string; machine_id: string };

    // Transport failures can retain authorization and lease headers.
    const sanitizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new Error(
              error instanceof Error ? error.name : "Fly SDK probe failed",
            ),
        ),
      );

    test(
      "pure lease cleanup fails before successful-body teardown and keeps diagnostics private",
      Effect.gen(function* () {
        let teardownReached = false;
        const exit = yield* Effect.gen(function* () {
          yield* scopedLeaseCleanup(
            Effect.fail({
              _tag: "ReleaseProbeFailure",
              privateValue: "cleanup-secret",
            }),
          ).pipe(Effect.scoped);
          teardownReached = true;
        }).pipe(Effect.exit);
        expect(teardownReached).toBe(false);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.pretty(exit.cause)).toContain(
            "Lease cleanup failed (ReleaseProbeFailure)",
          );
          expect(Cause.pretty(exit.cause)).not.toContain("cleanup-secret");
        }
      }),
    );

    test(
      "pure lease cleanup retains the primary failure alongside cleanup failure",
      Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          yield* scopedLeaseCleanup(
            Effect.fail({ _tag: "ReleaseProbeFailure" }),
          );
          return yield* Effect.fail("primary failure");
        }).pipe(Effect.scoped, Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.findError(exit.cause)).toEqual(
            Result.succeed("primary failure"),
          );
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.pretty(exit.cause)).toContain(
            "Lease cleanup failed (ReleaseProbeFailure)",
          );
        }
      }),
    );

    test(
      "pure lease cleanup timeout remains a test failure",
      Effect.gen(function* () {
        const exit = yield* scopedLeaseCleanup(
          Effect.never.pipe(Effect.timeout("1 millis")),
        ).pipe(Effect.scoped, Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain(
            "Lease cleanup failed (TimeoutError)",
          );
        }
      }),
    );

    test(
      "pure lease cleanup does not repeat a successful explicit release or confirmed absence",
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        yield* Effect.gen(function* () {
          const cleanup = yield* scopedLeaseCleanup(
            Ref.update(calls, (n) => n + 1),
          );
          yield* cleanup.release;
          yield* cleanup.release;
        }).pipe(Effect.scoped);
        expect(yield* Ref.get(calls)).toBe(1);
        yield* Effect.gen(function* () {
          const cleanup = yield* scopedLeaseCleanup(
            Ref.update(calls, (n) => n + 1),
          );
          yield* cleanup.complete;
        }).pipe(Effect.scoped);
        expect(yield* Ref.get(calls)).toBe(1);
      }),
    );

    const differentNonce = (nonce: string) =>
      `${nonce[0] === "a" ? "b" : "a"}${nonce.slice(1)}`;

    test(
      "P4 pure HTTP 408 status mapping agrees with the Fly timeout model",
      Effect.sync(() => {
        expect(HTTP_STATUS_MAP[408]).toBe(GatewayTimeout);
        expect(RETRYABLE_HTTP_STATUSES.has(408)).toBe(true);
      }),
    );

    const observeTransport = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return client.pipe(
        HttpClient.transform((response, request) =>
          response.pipe(
            Effect.tap((actual) =>
              Effect.logInfo("Fly SDK probe transport", {
                method: request.method,
                path: request.url.split("?")[0],
                status: actual.status,
                ttl:
                  request.url.match(/[?&]ttl=(\d+)/)?.[1] ??
                  request.urlParams.params.find(([key]) => key === "ttl")?.[1],
                nonceHeader: !!request.headers["fly-machine-lease-nonce"],
              }),
            ),
          ),
        ),
      );
    });

    const scopedLeaseCleanup = <A, E extends { readonly _tag: string }, R>(
      action: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const completed = yield* Ref.make(false);
        const complete = Ref.set(completed, true);
        const release = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (yield* Ref.get(completed)) return;
            yield* restore(action);
            yield* complete;
          }),
        );
        yield* Effect.addFinalizer(() =>
          release.pipe(
            Effect.interruptible,
            Effect.catchCause((cause) => {
              const error = Cause.findError(cause);
              const tag = Result.isSuccess(error)
                ? error.success._tag
                : Cause.hasInterrupts(cause)
                  ? "Interrupted"
                  : "Defect";
              return Effect.die(new Error(`Lease cleanup failed (${tag})`));
            }),
          ),
        );
        return { release, complete };
      });

    const lease = (target: Target, ttl = 120) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("P1 acquiring native lease", {
          machineId: target.machine_id,
          ttl,
        });
        const acquired = yield* machines
          .createMachineLease({ ...target, ttl })
          .pipe(Effect.timeout("15 seconds"));
        const nonce = acquired.data?.nonce;
        if (!nonce)
          return yield* Effect.fail(new Error("Lease response has no nonce"));
        const cleanup = yield* scopedLeaseCleanup(
          machines
            .machinesReleaseLease({ ...target, lease_nonce: nonce })
            .pipe(Retry.none, Effect.timeout("15 seconds")),
        );
        return {
          acquired,
          nonce,
          release: cleanup.release,
          confirmDeleted: expectGone(target).pipe(
            Effect.andThen(cleanup.complete),
          ),
          confirmExpired: Effect.gen(function* () {
            const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
            expect(acquired.data?.expires_at).toBeLessThanOrEqual(now);
            const current = yield* machines.getMachineLease(target).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              Effect.timeout("15 seconds"),
            );
            expect(current?.data?.nonce === nonce).toBe(false);
            yield* cleanup.complete;
          }),
        };
      });

    const expectFailure = <A, E extends { readonly _tag: string }, R>(
      attempt: Effect.Effect<A, E, R>,
      tag: "Conflict" | "Forbidden" = "Conflict",
    ) =>
      attempt.pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag);
          }),
        ),
        Effect.asVoid,
      );

    const waitState = (target: Target, state: string) =>
      machines.getMachine(target).pipe(
        Retry.none,
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (machine) => machine.state === state,
          times: 8,
        }),
        Effect.tap((machine) =>
          Effect.sync(() => expect(machine.state).toBe(state)),
        ),
      );

    const expectGone = (target: Target) =>
      machines.getMachine(target).pipe(
        Retry.none,
        Effect.map((machine) => machine.state === "destroyed"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: Boolean,
          times: 8,
        }),
        Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
      );

    test.provider(
      "P1/P2 lease envelope, query TTL, renewal, contention and release on a real Machine",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("LeaseSite");
              return yield* Fly.Machine("LeaseTarget", {
                app,
                region: "iad",
                image: "nginx:alpine",
                guest: { cpus: 1, memoryMb: 256 },
                skipLaunch: true,
              });
            }),
          );
          const target = {
            app_name: created.appName,
            machine_id: created.machineId,
          };
          const client = yield* observeTransport;
          yield* Effect.gen(function* () {
            const before = yield* Effect.sync(() =>
              Math.floor(Date.now() / 1000),
            );
            const held = yield* lease(target);
            const { acquired, nonce } = held;
            expect(acquired.status).toBe("success");
            expect(typeof acquired.data?.owner).toBe("string");
            expect(typeof acquired.data?.version).toBe("string");
            expect(acquired.data?.expires_at).toBeGreaterThanOrEqual(
              before + 115,
            );
            expect(acquired.data?.expires_at).toBeLessThanOrEqual(before + 130);
            yield* Effect.logInfo("P1 lease envelope verified", {
              keys: Object.keys(acquired),
              dataKeys: Object.keys(acquired.data ?? {}),
              ttlSeconds: acquired.data!.expires_at! - before,
            });
            const observed = yield* machines.getMachineLease(target);
            expect(observed.data?.expires_at).toBe(acquired.data?.expires_at);
            yield* expectFailure(
              machines.createMachineLease({ ...target, ttl: 120 }),
            );
            yield* expectFailure(
              machines.createMachineLease({
                ...target,
                ttl: 120,
                lease_nonce: differentNonce(nonce),
              }),
            );
            yield* expectFailure(
              machines.machinesReleaseLease({
                ...target,
                lease_nonce: differentNonce(nonce),
              }),
              "Forbidden",
            );
            const refreshed = yield* machines.createMachineLease({
              ...target,
              ttl: 120,
              lease_nonce: nonce,
            });
            expect(refreshed.data?.nonce === nonce).toBe(true);
            expect(refreshed.data?.expires_at).toBeGreaterThanOrEqual(
              acquired.data!.expires_at!,
            );
            yield* held.release;
            const next = yield* lease(target);
            expect(next.nonce !== nonce).toBe(true);
          }).pipe(
            Effect.scoped,
            Retry.none,
            Effect.provideService(HttpClient.HttpClient, client),
          );
          yield* stack.destroy();
          yield* expectGone(target);
        }).pipe(sanitizeFailure),
      { tags: ["provider:fly:app", "provider:fly:machine"], timeout: 120_000 },
    );

    test.provider(
      "P1/P2 native nonce enforcement and metadata boundary on a real Machine",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("EnforcementSite");
              return yield* Fly.Machine("EnforcementTarget", {
                app,
                region: "iad",
                image: "nginx:alpine",
                guest: { cpus: 1, memoryMb: 256 },
                restart: { policy: "always" },
                services: [
                  {
                    protocol: "tcp",
                    internalPort: 80,
                    ports: [{ port: 80, handlers: ["http"] }],
                    checks: [
                      {
                        type: "http",
                        port: 80,
                        path: "/",
                        interval: "2s",
                        timeout: "1s",
                      },
                    ],
                  },
                ],
              });
            }),
          );
          const target = {
            app_name: created.appName,
            machine_id: created.machineId,
          };
          const client = yield* observeTransport;
          yield* Effect.gen(function* () {
            const held = yield* lease(target);
            const { acquired, nonce } = held;
            const verifyAuthority = (minimumRemainingSeconds = 0) =>
              Effect.gen(function* () {
                const held = yield* machines
                  .getMachineLease(target)
                  .pipe(Effect.timeout("15 seconds"));
                const now = yield* Effect.sync(() =>
                  Math.floor(Date.now() / 1000),
                );
                expect(held.data?.nonce === nonce).toBe(true);
                expect(held.data?.owner === acquired.data?.owner).toBe(true);
                expect(held.data?.expires_at).toBeGreaterThan(
                  now + minimumRemainingSeconds,
                );
              });
            const refreshAuthority = Effect.gen(function* () {
              yield* verifyAuthority(15);
              const refreshed = yield* machines
                .createMachineLease({ ...target, ttl: 120, lease_nonce: nonce })
                .pipe(Effect.timeout("15 seconds"));
              expect(refreshed.data?.nonce === nonce).toBe(true);
              // A complete request and its authority readback must fit inside the lease.
              yield* verifyAuthority(90);
            });
            const withAuthority = <A, E, R>(phase: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                yield* refreshAuthority;
                const value = yield* phase.pipe(Effect.timeout("60 seconds"));
                yield* verifyAuthority();
                return value;
              });
            const initial = yield* withAuthority(machines.getMachine(target));
            const outcomes: string[] = [];
            for (const lease_nonce of [undefined, differentNonce(nonce)]) {
              const request = { ...target, lease_nonce };
              const attempts = [
                [
                  "update",
                  machines.updateMachine({
                    ...request,
                    config: initial.config,
                  }),
                ],
                ["start", machines.startMachine(request)],
                ["cordon", machines.cordonMachine(request)],
                ["uncordon", machines.uncordonMachine(request)],
                [
                  "stop",
                  machines.stopMachine({
                    ...request,
                    signal: "SIGTERM",
                    timeout: "5s",
                  }),
                ],
                ["suspend", machines.suspendMachine(request)],
                [
                  "restart",
                  machines.restartMachine({
                    ...request,
                    signal: "SIGTERM",
                    timeout: "5s",
                  }),
                ],
                ["delete", machines.deleteMachine({ ...request, force: true })],
              ] as const;
              for (const [operation, attempt] of attempts) {
                yield* refreshAuthority;
                const result = yield* attempt.pipe(
                  Effect.timeout("60 seconds"),
                  Effect.result,
                );
                yield* verifyAuthority();
                yield* Effect.logInfo("P1 mutation enforcement", {
                  operation,
                  nonce: lease_nonce ? "wrong" : "absent",
                  outcome: Result.isFailure(result)
                    ? result.failure._tag
                    : "accepted",
                });
                outcomes.push(
                  Result.isFailure(result) ? result.failure._tag : "accepted",
                );
                expect(Result.isFailure(result)).toBe(true);
              }
            }
            const intact = yield* withAuthority(machines.getMachine(target));
            expect(intact.state).toBe("started");
            expect(intact.instance_id).toBe(initial.instance_id);
            const metadata = yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.upsertMachineMetadata({
                  ...target,
                  key: "lease-probe",
                  value: "metadata-is-not-fenced",
                });
                const observed = yield* machines.getMachine(target);
                expect(observed.config?.metadata?.["lease-probe"]).toBe(
                  "metadata-is-not-fenced",
                );
                return observed;
              }),
            );
            yield* Effect.logInfo(
              "P2 metadata mutation bypasses target lease",
              {
                checksAfterMutation: metadata.checks?.length ?? 0,
              },
            );
            const request = { ...target, lease_nonce: nonce };
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.updateMachine({
                  ...request,
                  config: {
                    ...metadata.config,
                    env: { ...metadata.config?.env, LEASE_PROBE: "updated" },
                  },
                });
                yield* waitState(target, "started");
                expect(
                  (yield* machines.getMachine(target)).config?.env?.LEASE_PROBE,
                ).toBe("updated");
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.cordonMachine(request);
                expect((yield* machines.getMachine(target)).cordoned).toBe(
                  true,
                );
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.uncordonMachine(request);
                expect((yield* machines.getMachine(target)).cordoned).toBe(
                  false,
                );
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.stopMachine({
                  ...request,
                  signal: "SIGTERM",
                  timeout: "5s",
                });
                yield* waitState(target, "stopped");
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.startMachine(request);
                yield* waitState(target, "started");
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.restartMachine({
                  ...request,
                  signal: "SIGTERM",
                  timeout: "5s",
                });
                yield* waitState(target, "started");
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.suspendMachine(request);
                yield* waitState(target, "suspended");
              }),
            );
            yield* withAuthority(
              Effect.gen(function* () {
                yield* machines.stopMachine({
                  ...request,
                  signal: "SIGTERM",
                  timeout: "5s",
                });
                yield* waitState(target, "stopped");
              }),
            );
            yield* refreshAuthority;
            yield* machines
              .deleteMachine(request)
              .pipe(Effect.timeout("60 seconds"));
            yield* held.confirmDeleted.pipe(Effect.timeout("30 seconds"));
            expect(outcomes).toEqual(Array(16).fill("Conflict"));
          }).pipe(
            Effect.scoped,
            Retry.none,
            Effect.provideService(HttpClient.HttpClient, client),
          );
          yield* stack.destroy();
          yield* expectGone(target);
        }).pipe(sanitizeFailure),
      {
        tags: ["provider:fly:app", "provider:fly:machine"],
        timeout: 30 * 60_000,
      },
    );

    test.provider(
      "P2 partial acquisition cleanup, expiry and lost authority during a real mutation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("LifetimeSite");
              return yield* Fly.Machine("LifetimeTargets", {
                app,
                region: "iad",
                image: "nginx:alpine",
                count: 2,
                guest: { cpus: 1, memoryMb: 256 },
                skipLaunch: true,
              });
            }),
          );
          const first = {
            app_name: created.appName,
            machine_id: created.machineIds[0]!,
          };
          const second = {
            app_name: created.appName,
            machine_id: created.machineIds[1]!,
          };
          yield* Effect.gen(function* () {
            yield* lease(first);
            const partial = yield* Effect.gen(function* () {
              yield* lease(second);
              yield* machines.createMachineLease({ ...first, ttl: 120 });
            }).pipe(Effect.scoped, Effect.result);
            expect(Result.isFailure(partial)).toBe(true);
            if (Result.isFailure(partial))
              expect(partial.failure).toMatchObject({ _tag: "Conflict" });
            const before = yield* Effect.sync(() =>
              Math.floor(Date.now() / 1000),
            );
            const expired = yield* lease(second, 2);
            expect(expired.acquired.data?.expires_at).toBeLessThanOrEqual(
              before + 5,
            );
            yield* Effect.sleep("3 seconds");
            const successor = yield* lease(second);
            expect(successor.nonce !== expired.nonce).toBe(true);
            yield* expired.confirmExpired;
            const observed = yield* machines.getMachine(second);
            yield* expectFailure(
              machines.updateMachine({
                ...second,
                lease_nonce: expired.nonce,
                config: observed.config,
                skip_launch: true,
              }),
            );
            yield* expectFailure(
              machines.createMachineLease({
                ...second,
                lease_nonce: expired.nonce,
                ttl: 120,
              }),
            );
            yield* expectFailure(
              machines.machinesReleaseLease({
                ...second,
                lease_nonce: expired.nonce,
              }),
              "Forbidden",
            );
            const stillHeld = yield* machines.getMachineLease(second);
            expect(stillHeld.data?.expires_at).toBe(
              successor.acquired.data?.expires_at,
            );
          }).pipe(Effect.scoped, Retry.none);
          yield* stack.destroy();
          yield* expectGone(first);
          yield* expectGone(second);
        }).pipe(sanitizeFailure),
      { tags: ["provider:fly:app", "provider:fly:machine"], timeout: 120_000 },
    );

    test.provider(
      "P4 duplicate create name Conflict permits exact owned Machine readback",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("IdentitySite");
              return yield* Fly.Machine("IdentityTarget", {
                app,
                region: "iad",
                image: "nginx:alpine",
                guest: { cpus: 1, memoryMb: 256 },
                skipLaunch: true,
              });
            }),
          );
          const target = {
            app_name: created.appName,
            machine_id: created.machineId,
          };
          const observed = yield* machines.getMachine(target);
          yield* expectFailure(
            machines
              .createMachine({
                app_name: created.appName,
                name: created.name,
                region: "iad",
                config: observed.config,
                skip_launch: true,
              })
              .pipe(Retry.none),
          );
          const matches = (yield* machines.listMachines({
            app_name: created.appName,
          })).filter(
            (machine) =>
              machine.name === created.name && machine.state !== "destroyed",
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]?.id).toBe(created.machineId);
          expect(matches[0]?.config?.metadata).toEqual(
            observed.config?.metadata,
          );
          expect(matches[0]?.image_ref?.digest).toBe(
            observed.image_ref?.digest,
          );
          yield* stack.destroy();
          yield* expectGone(target);
        }).pipe(sanitizeFailure),
      { tags: ["provider:fly:app", "provider:fly:machine"], timeout: 120_000 },
    );

    test.provider(
      "P4 lost completed create response reuses its unique owned name",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("LostCreateSite"));
          const request: machines.CreateMachineRequest = {
            app_name: app.appName,
            name: "lost-create-target",
            region: "iad",
            skip_launch: true,
            config: {
              image: "nginx:alpine",
              guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
              metadata: { "sdk-probe-owner": "completed-response-loss" },
            },
          };
          yield* Effect.gen(function* () {
            const proxy = yield* dropCompletedCreate(app.appName);
            const result = yield* machines
              .createMachine(request)
              .pipe(
                Retry.none,
                Effect.provideService(Credentials, proxy.credentials),
                Effect.timeout("15 seconds"),
                Effect.result,
              );
            yield* Effect.logInfo("P4 transport fault outcome", {
              forwarded: yield* proxy.forwarded,
              completedStatus: yield* proxy.completedStatus,
              outcome: Result.isFailure(result)
                ? result.failure._tag
                : "accepted",
              rejection:
                Result.isFailure(result) && result.failure._tag === "BadRequest"
                  ? result.failure.message
                  : undefined,
            });
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe("HttpClientError");
              if (result.failure._tag === "HttpClientError")
                expect(result.failure.reason._tag).toBe("TransportError");
            }
            expect(yield* proxy.forwarded).toBe(1);
            expect([200, 201]).toContain(yield* proxy.completedStatus);
            yield* Effect.logInfo("P4 completed create response dropped", {
              status: yield* proxy.completedStatus,
              forwarded: yield* proxy.forwarded,
            });
          }).pipe(Effect.scoped);
          const matches = (yield* machines.listMachines({
            app_name: app.appName,
          })).filter(
            (machine) =>
              machine.name === request.name && machine.state !== "destroyed",
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]?.config?.metadata?.["sdk-probe-owner"]).toBe(
            "completed-response-loss",
          );
          yield* expectFailure(
            machines.createMachine(request).pipe(Retry.none),
          );
          const after = (yield* machines.listMachines({
            app_name: app.appName,
          })).filter(
            (machine) =>
              machine.name === request.name && machine.state !== "destroyed",
          );
          expect(after.map((machine) => machine.id)).toEqual(
            matches.map((machine) => machine.id),
          );
          yield* stack.destroy();
          yield* expectGone({
            app_name: app.appName,
            machine_id: matches[0]!.id!,
          });
        }).pipe(sanitizeFailure),
      { tags: ["provider:fly:app", "provider:fly:machine"], timeout: 120_000 },
    );

    const p3CheckNames = [
      "servicecheck-00-http-80",
      "servicecheck-00-tcp-80",
      "ready",
    ];

    interface RestoredReadiness {
      previousInstance: string;
      after: number;
      checks: ReadonlyMap<string, number>;
    }

    const readyCheckReports = (
      reports: ReadonlyArray<machines.CheckStatus> | undefined,
      freshness?: RestoredReadiness,
    ) =>
      p3CheckNames.every((name) => {
        const matching = reports?.filter((check) => check.name === name) ?? [];
        if (matching.length !== 1 || matching[0]!.status !== "passing")
          return false;
        const observedAt = Date.parse(matching[0]!.updated_at ?? "");
        if (!Number.isFinite(observedAt)) return false;
        if (!freshness) return true;
        const previous = freshness.checks.get(name);
        return (
          previous !== undefined &&
          Number.isFinite(previous) &&
          observedAt > previous &&
          observedAt >= freshness.after
        );
      });

    const wireAutostop = (value: string | boolean | undefined) =>
      value === true ? "stop" : value === false ? "off" : value;

    test(
      "P3 pure readiness rejects stale, missing, duplicate and undated check observations",
      Effect.sync(() => {
        const freshness: RestoredReadiness = {
          previousInstance: "prepared",
          after: 2_000,
          checks: new Map(p3CheckNames.map((name) => [name, 1_000])),
        };
        const reports = p3CheckNames.map((name) => ({
          name,
          status: "passing",
          updated_at: new Date(3_000).toISOString(),
        }));
        expect(readyCheckReports(reports, freshness)).toBe(true);
        for (const updated_at of [
          new Date(1_000).toISOString(),
          new Date(1_500).toISOString(),
          "invalid",
          undefined,
        ]) {
          expect(
            readyCheckReports(
              [{ ...reports[0]!, updated_at }, ...reports.slice(1)],
              freshness,
            ),
          ).toBe(false);
        }
        expect(readyCheckReports(reports.slice(1), freshness)).toBe(false);
        expect(readyCheckReports([...reports, reports[0]!], freshness)).toBe(
          false,
        );
      }),
      { tags: ["provider:fly:machine"] },
    );

    test(
      "P3 pure autostop schema accepts strings and legacy booleans",
      Effect.sync(() => {
        const decode = Schema.decodeUnknownSync(
          machines.FlyMachineServiceAutostop,
        );
        for (const value of ["off", "stop", "suspend", false, true]) {
          expect(decode(value)).toBe(value);
        }
        expect(() => decode({ mode: "stop" })).toThrow();
        expect(() => decode(1)).toThrow();
      }),
      { tags: ["provider:fly:machine"] },
    );

    for (const autostop of ["stop", "suspend"] as const) {
      test.provider(
        `P3 ${autostop} cordoned representative, restored checks and public autostart`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const created = yield* stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("IdleSite");
                yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                return yield* Fly.Machine("IdleTargets", {
                  app,
                  region: "iad",
                  image: "nginx:alpine",
                  count: 2,
                  guest: { cpus: 1, memoryMb: 256 },
                  skipLaunch: true,
                  checks: {
                    ready: {
                      type: "http",
                      port: 80,
                      path: "/",
                      interval: "2s",
                      timeout: "1s",
                    },
                  },
                  services: [
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop,
                      autostart: true,
                      minMachinesRunning: 1,
                      ports: [{ port: 443, handlers: ["tls", "http"] }],
                      checks: [
                        {
                          type: "http",
                          port: 80,
                          path: "/",
                          interval: "2s",
                          timeout: "1s",
                        },
                      ],
                    },
                    {
                      protocol: "tcp",
                      internalPort: 80,
                      autostop,
                      autostart: true,
                      minMachinesRunning: 0,
                      ports: [{ port: 8080, handlers: ["http"] }],
                      // Identical HTTP checks reported only one service-check identity.
                      checks: [
                        {
                          type: "tcp",
                          port: 80,
                          interval: "2s",
                          timeout: "1s",
                        },
                      ],
                    },
                  ],
                });
              }),
            );
            const target = {
              app_name: created.appName,
              machine_id: created.machineIds[0]!,
            };
            const idle = {
              app_name: created.appName,
              machine_id: created.machineIds[1]!,
            };
            const client = yield* observeTransport;
            const healthy = (
              mode: "off" | "stop" | "suspend",
              freshness?: RestoredReadiness,
            ) => {
              const isReady = (machine: machines.Machine) => {
                const services = machine.config?.services;
                return (
                  machine.state === "started" &&
                  machine.cordoned === true &&
                  !!machine.instance_id &&
                  (!freshness ||
                    machine.instance_id !== freshness.previousInstance) &&
                  readyCheckReports(machine.checks, freshness) &&
                  services?.length === 2 &&
                  services.every(
                    (service, index) =>
                      wireAutostop(service.autostop) === mode &&
                      service.autostart === true &&
                      service.min_machines_running === (index === 0 ? 1 : 0),
                  )
                );
              };
              return machines.getMachine(target).pipe(
                Retry.none,
                Effect.repeat({
                  schedule: Schedule.spaced("3 seconds"),
                  times: 8,
                  until: isReady,
                }),
                Effect.tap((machine) =>
                  Effect.logInfo("P3 observed readiness reports", {
                    state: machine.state,
                    instance: machine.instance_id,
                    checks: machine.checks?.map((check) => ({
                      name: check.name,
                      status: check.status,
                      updatedAt: check.updated_at,
                    })),
                    named: Object.keys(machine.config?.checks ?? {}),
                    serviceCheckCounts: machine.config?.services?.map(
                      (service) => service.checks?.length ?? 0,
                    ),
                  }),
                ),
                Effect.tap((machine) =>
                  Effect.sync(() => expect(isReady(machine)).toBe(true)),
                ),
              );
            };
            yield* Effect.gen(function* () {
              const held = yield* lease(target);
              const { nonce } = held;
              const other = yield* lease(idle);
              const request = { ...target, lease_nonce: nonce };
              const initial = yield* machines.getMachine(target);
              const config = initial.config!;
              yield* machines.updateMachine({
                ...request,
                config: {
                  ...config,
                  services: config.services?.map((service) => ({
                    ...service,
                    autostop: "off",
                  })),
                },
                skip_launch: true,
                skip_service_registration: true,
              });
              yield* machines.cordonMachine({
                ...idle,
                lease_nonce: other.nonce,
              });
              yield* machines.cordonMachine(request);
              yield* machines.startMachine(request).pipe(
                Effect.retry({
                  while: (error) => error._tag === "MachineReplacing",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                }),
                Effect.timeout("20 seconds"),
              );
              yield* waitState(target, "started");
              const prepared = yield* healthy("off");
              expect(prepared.cordoned).toBe(true);
              expect(["created", "stopped"]).toContain(
                (yield* machines.getMachine(idle)).state,
              );
              if (!prepared.instance_id) {
                return yield* Effect.fail(
                  new Error("Prepared Machine has no instance ID"),
                );
              }
              const previousChecks = yield* Effect.sync(
                () =>
                  new Map<string, number>(
                    p3CheckNames.map((name) => [
                      name,
                      Date.parse(
                        prepared.checks?.find((check) => check.name === name)
                          ?.updated_at ?? "",
                      ),
                    ]),
                  ),
              );
              const freshness: RestoredReadiness = {
                previousInstance: prepared.instance_id,
                checks: previousChecks,
                after: yield* Effect.sync(() => Date.now()),
              };
              yield* machines.updateMachine({
                ...request,
                config,
                skip_service_registration: true,
              });
              yield* waitState(target, "started");
              const restored = yield* healthy(autostop, freshness);
              expect(restored.instance_id).not.toBe(prepared.instance_id);
              expect(readyCheckReports(restored.checks, freshness)).toBe(true);
              yield* Effect.logInfo("P3 restored idle policy", {
                autostop,
                instanceChanged: prepared.instance_id !== restored.instance_id,
                services: restored.config?.services?.map((service) => ({
                  autostop: service.autostop,
                  autostart: service.autostart,
                  minimum: service.min_machines_running,
                })),
                checks: restored.checks?.map((check) => ({
                  name: check.name,
                  status: check.status,
                  updatedAt: check.updated_at,
                })),
              });
              expect(
                restored.config?.services?.map(
                  (service) => service.min_machines_running,
                ),
              ).toEqual([1, 0]);
              expect(
                restored.config?.services?.map((service) =>
                  wireAutostop(service.autostop),
                ),
              ).toEqual([autostop, autostop]);
              expect(
                restored.config?.services?.map((service) => service.autostart),
              ).toEqual([true, true]);
              yield* machines.uncordonMachine(request);
              yield* machines.uncordonMachine({
                ...idle,
                lease_nonce: other.nonce,
              });
              if (autostop === "suspend") {
                yield* machines
                  .suspendMachine(request)
                  .pipe(Effect.timeout("15 seconds"));
                yield* waitState(target, "suspended");
              } else {
                yield* machines.stopMachine({
                  ...request,
                  signal: "SIGTERM",
                  timeout: "5s",
                });
                yield* waitState(target, "stopped");
              }
              // Fly Proxy must be free to start either Machine without our nonce.
              yield* held.release;
              yield* other.release;
              yield* Effect.logInfo(
                "P3 released own leases before proxy autostart",
              );
              const beforeRequest = (yield* machines.listMachines({
                app_name: created.appName,
              })).filter(
                (machine) =>
                  machine.id === target.machine_id ||
                  machine.id === idle.machine_id,
              );
              expect(beforeRequest.length).toBe(2);
              expect(
                beforeRequest.every(
                  (machine) =>
                    machine.state === "created" ||
                    machine.state === "stopped" ||
                    machine.state === "suspended",
                ),
              ).toBe(true);
              const response = yield* client
                .pipe(HttpClient.filterStatusOk)
                .get(`https://${created.appName}.fly.dev`)
                .pipe(
                  Effect.timeout("5 seconds"),
                  Effect.retry({
                    schedule: Schedule.spaced("2 seconds"),
                    times: 3,
                  }),
                );
              expect(response.status).toBe(200);
              const states = yield* machines.listMachines({
                app_name: created.appName,
              });
              expect(
                states.some(
                  (machine) =>
                    machine.state === "started" &&
                    beforeRequest.some((before) => before.id === machine.id),
                ),
              ).toBe(true);
              yield* Effect.logInfo("P3 public proxy autostart verified", {
                autostop,
                states: states.map((machine) => machine.state),
              });
            }).pipe(
              Effect.scoped,
              Retry.none,
              Effect.provideService(HttpClient.HttpClient, client),
            );
            yield* stack.destroy();
            yield* expectGone(target);
            yield* expectGone(idle);
          }).pipe(sanitizeFailure),
        {
          tags: [
            "provider:fly:app",
            "provider:fly:ipassignment",
            "provider:fly:machine",
          ],
          timeout: 5 * 60_000,
        },
      );
    }
  },
);

describe.sequential(
  "legacy compatibility",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    let endpoint: string | undefined;
    let stops: StopRequest[] = [];
    const { test } = Test.make({
      providers: observeStops(
        () => endpoint,
        (request) => stops.push(request),
      ),
    });

    const runningLegacy = (appName: string, id: string) =>
      machines.getMachine({ app_name: appName, machine_id: id }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 45,
          until: (machine) =>
            machine.state === "started" &&
            machine.config?.metadata?.["alchemy.deployment-protocol"] ===
              undefined &&
            machine.config?.metadata?.["alchemy.generation"] === undefined &&
            machine.config?.stop_config === undefined,
        }),
        Effect.timeout("120 seconds"),
        Effect.tap((machine) =>
          Effect.sync(() => {
            expect(machine.state).toBe("started");
            expect(machine.config?.stop_config).toBeUndefined();
            expect(
              machine.config?.metadata?.["alchemy.deployment-protocol"],
            ).toBeUndefined();
            expect(
              machine.config?.metadata?.["alchemy.generation"],
            ).toBeUndefined();
          }),
        ),
      );

    describe.sequential("live legacy protocol compatibility models", () => {
      for (const runtimeTimeoutMs of [undefined, 10_000, 60_000]) {
        test.provider(
          `F14 live legacy missing stop_config ${runtimeTimeoutMs === undefined ? "preserves raw-image defaults" : `uses ${runtimeTimeoutMs}ms runtime-env fallback`}`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const site = yield* stack.deploy(Fly.App("Site"));
              try {
                const initial = yield* deployWorker(stack, "one", {
                  deploy: { strategy: "rolling" },
                  shutdown: undefined,
                });
                yield* writeLegacyProtocol(
                  site.appName,
                  initial.machineId,
                  runtimeTimeoutMs,
                );
                const legacy = yield* runningLegacy(
                  site.appName,
                  initial.machineId,
                );
                expect(
                  legacy.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS,
                ).toBe(runtimeTimeoutMs?.toString());
                const policy = yield* predecessorShutdown(legacy);
                if (runtimeTimeoutMs === undefined) {
                  expect(policy.signal).toBeUndefined();
                  expect(policy.timeout).toBeUndefined();
                } else {
                  expect(policy.signal).toBe("SIGTERM");
                  expect(policy.timeout).toBe(`${runtimeTimeoutMs}ms`);
                  expect(policy.timeoutMs).toBe(runtimeTimeoutMs);
                }
                const proxy = yield* transportProxy();
                yield* Effect.sync(() => {
                  endpoint = proxy.url;
                  stops = [];
                });
                const upgraded = yield* deployWorker(stack, "two", {
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "60 seconds",
                  },
                });
                expect(upgraded.machineId).not.toBe(initial.machineId);
                yield* assertCommitted(site.appName, upgraded.machineIds);
                const stop = stops.filter(
                  (request) => request.machineId === initial.machineId,
                );
                expect(stop).toHaveLength(1);
                expect(stop[0]!.signal).toBe(
                  runtimeTimeoutMs === undefined ? undefined : "SIGTERM",
                );
                expect(stop[0]!.timeout).toBe(
                  runtimeTimeoutMs === undefined
                    ? undefined
                    : `${runtimeTimeoutMs}ms`,
                );
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.machineId === initial.machineId &&
                      event.path.endsWith("/stop") &&
                      event.status! >= 200 &&
                      event.status! < 300,
                  ),
                ).toBe(true);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.machineId === initial.machineId &&
                      event.method === "DELETE" &&
                      /\/machines\/[^/]+$/.test(event.path) &&
                      event.status! >= 200 &&
                      event.status! < 300,
                  ),
                ).toBe(true);
                const same = yield* deployWorker(stack, "two", {
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "65 seconds",
                  },
                });
                expect(same.machineIds).toEqual(upgraded.machineIds);
              } finally {
                yield* Effect.sync(() => {
                  endpoint = undefined;
                  stops = [];
                });
                yield* stack.destroy();
                yield* assertAppGone(site.appName);
              }
            }).pipe(Effect.scoped),
          { timeout: 900_000 },
        );
      }

      for (const affected of [1, 2]) {
        test.provider(
          `F14 unknown metadata protocol on ${affected} of 2 real Machines safely refuses without mutation`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const site = yield* stack.deploy(Fly.App("Site"));
              try {
                const initial = yield* deployWorker(stack, "one", { count: 2 });
                for (const id of initial.machineIds.slice(0, affected)) {
                  const target = { app_name: site.appName, machine_id: id };
                  const current = yield* machines.getMachine(target);
                  yield* machines.patchMachineMetadata({
                    ...target,
                    metadata: {
                      ...current.config!.metadata,
                      "alchemy.deployment-protocol": "future-unknown",
                    },
                  });
                }
                const before = yield* census(site.appName);
                expect(
                  before.filter(
                    (machine) =>
                      machine.config?.metadata?.[
                        "alchemy.deployment-protocol"
                      ] === "future-unknown",
                  ),
                ).toHaveLength(affected);
                const metadata = before[0]!.config!.metadata!;
                const read = yield* observeReplicaSet({
                  appName: site.appName,
                  id: "Worker",
                  type: "Fly.Machine",
                  fqn: metadata["alchemy.fqn"]!,
                  resourceInstanceId: metadata["alchemy.instance"]!,
                  machineIds: initial.machineIds,
                });
                expect(read?.rolloutPending).toBe(true);
                expect(read?.machineIds).toEqual([]);
                const proxy = yield* transportProxy();
                yield* Effect.sync(() => {
                  endpoint = proxy.url;
                });
                const result = yield* deployWorker(stack, "two", {
                  count: 2,
                }).pipe(Effect.timeout("180 seconds"), Effect.result);
                expect(Result.isFailure(result)).toBe(true);
                if (Result.isFailure(result)) {
                  expect(result.failure).toMatchObject({
                    _tag: "Fly.DeploymentRecoveryAmbiguous",
                  });
                }
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "request" &&
                      event.method !== "GET" &&
                      !event.path.endsWith("/lease"),
                  ),
                ).toBe(false);
                const after = yield* census(site.appName);
                expect(after.map((machine) => machine.id).sort()).toEqual(
                  initial.machineIds.slice().sort(),
                );
                for (const machine of after) {
                  const previous = before.find(
                    (item) => item.id === machine.id,
                  )!;
                  expect(machine.instance_id).toBe(previous.instance_id);
                  expect(machine.config).toEqual(previous.config);
                  expect(machine.cordoned).toBe(false);
                  expect(machine.state).toBe("started");
                }
              } finally {
                yield* Effect.sync(() => {
                  endpoint = undefined;
                });
                yield* stack.destroy();
                yield* assertAppGone(site.appName);
              }
            }).pipe(Effect.scoped),
          { timeout: 600_000 },
        );
      }

      test.provider(
        "F11 F14 partial upgrade with explicit native legacy-protocol writer honors current leases but has no old-binary global fence",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const site = yield* stack.deploy(Fly.App("Site"));
            try {
              const first = yield* deployWorker(stack, "one", { count: 2 });
              yield* writeLegacyProtocol(
                site.appName,
                first.machineIds[0]!,
                60_000,
              );
              yield* runningLegacy(site.appName, first.machineIds[0]!);
              const mixed = yield* census(site.appName);
              expect(
                mixed.filter(
                  (machine) =>
                    machine.config?.metadata?.[
                      "alchemy.deployment-protocol"
                    ] === "1",
                ),
              ).toHaveLength(1);
              expect(
                mixed.filter(
                  (machine) =>
                    machine.config?.metadata?.[
                      "alchemy.deployment-protocol"
                    ] === undefined,
                ),
              ).toHaveLength(1);
              const proxy = yield* transportProxy();
              try {
                yield* Effect.sync(() =>
                  proxy.arm({
                    match: (event) =>
                      event.method === "POST" &&
                      event.path.endsWith("/machines"),
                    action: "hold-response",
                    remaining: 1,
                  }),
                );
                yield* Effect.gen(function* () {
                  const actor = yield* engineActor(
                    stack,
                    "F11 F14 partial upgrade with explicit native legacy-protocol writer honors current leases but has no old-binary global fence",
                    file,
                    proxy.url,
                  );
                  const upgrade = yield* deployWorker(actor, "two", {
                    count: 2,
                  }).pipe(Effect.scoped, Effect.forkScoped);
                  yield* proxy.wait(
                    (event) =>
                      event.stage === "held" &&
                      event.status! >= 200 &&
                      event.status! < 300,
                  );
                  const competing = yield* writeLegacyProtocol(
                    site.appName,
                    first.machineIds[1]!,
                  ).pipe(Effect.result);
                  expect(Result.isFailure(competing)).toBe(true);
                  if (Result.isFailure(competing))
                    expect(competing.failure._tag).toBe("Conflict");
                  expect(
                    (yield* census(site.appName)).filter((machine) =>
                      first.machineIds.includes(machine.id!),
                    ),
                  ).toHaveLength(2);
                  yield* Effect.sync(() => {
                    proxy.clear();
                    proxy.release();
                  });
                  const upgraded = yield* Fiber.join(upgrade).pipe(
                    Effect.timeout("300 seconds"),
                  );
                  yield* assertCommitted(site.appName, upgraded.machineIds);
                  // A lease-aware legacy writer can still change a successor after lease release.
                  yield* writeLegacyProtocol(
                    site.appName,
                    upgraded.machineIds[0]!,
                    60_000,
                  );
                  yield* runningLegacy(site.appName, upgraded.machineIds[0]!);
                  const partial = yield* census(site.appName);
                  expect(partial.map((machine) => machine.id).sort()).toEqual(
                    upgraded.machineIds.slice().sort(),
                  );
                  expect(
                    partial.filter(
                      (machine) =>
                        machine.config?.metadata?.[
                          "alchemy.deployment-protocol"
                        ] === undefined,
                    ),
                  ).toHaveLength(1);
                  const resumed = yield* engineActor(
                    stack,
                    "F11 F14 partial upgrade with explicit native legacy-protocol writer honors current leases but has no old-binary global fence",
                    file,
                  );
                  const recovered = yield* deployWorker(resumed, "three", {
                    count: 2,
                  }).pipe(Effect.scoped);
                  expect(
                    recovered.machineIds.every(
                      (id) => !upgraded.machineIds.includes(id),
                    ),
                  ).toBe(true);
                  yield* assertCommitted(site.appName, recovered.machineIds);
                  yield* Effect.logInfo("Partial-upgrade model boundary", {
                    model:
                      "native lease-aware legacy protocol writer, not a literal old binary",
                    globalFence: false,
                    recoveredCount: recovered.machineIds.length,
                  });
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      proxy.clear();
                      proxy.release();
                    }),
                  ),
                  Effect.scoped,
                );
              } finally {
                yield* Effect.sync(() => {
                  proxy.clear();
                  proxy.release();
                });
              }
            } finally {
              yield* stack.destroy();
              yield* assertAppGone(site.appName);
            }
          }).pipe(Effect.scoped),
        { timeout: 900_000 },
      );
    });
  },
);

describe.sequential(
  "check cadence",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const file = "test/Fly/BlueGreen.test.ts";
    const { test } = Test.make({ providers: Fly.providers() });

    const cadenceCheck = {
      ...checks.ready,
      path: "/cadence-ready",
      interval: "75s",
      gracePeriod: "0s",
    };

    describe.sequential("live long-cadence readiness and service interval limits", () => {
      for (const kind of ["named", "service"] as const) {
        for (const sufficient of [false, true]) {
          const budget = sufficient ? 120_000 : 35_000;

          test.provider(
            `S06 ${kind === "named" ? "named 75-second check interval" : "service 75-second interval capped by Fly to 60 seconds"} with zero grace ${sufficient ? "passes the next real report within a 120-second health budget" : "fails a 35-second budget without retiring predecessors"}`,
            (stack) =>
              Effect.gen(function* () {
                yield* stack.destroy();
                const site = yield* stack.deploy(Fly.App("Site"));
                try {
                  const first = yield* deployWorker(stack, "one");
                  const proxy = yield* readinessProxy();
                  const actor = yield* readinessActor(
                    stack,
                    `S06 ${kind === "named" ? "named 75-second check interval" : "service 75-second interval capped by Fly to 60 seconds"} with zero grace ${sufficient ? "passes the next real report within a 120-second health budget" : "fails a 35-second budget without retiring predecessors"}`,
                    file,
                    proxy,
                  );
                  const props: Partial<
                    Omit<Extract<MachineProps, { image: string }>, "app">
                  > = {
                    init: {
                      exec: [
                        "/bin/sh",
                        "-c",
                        "rm -f /usr/share/nginx/html/cadence-ready; (sleep 80; touch /usr/share/nginx/html/cadence-ready) & exec nginx -g 'daemon off;'",
                      ],
                    },
                    checks: kind === "named" ? { ready: cadenceCheck } : {},
                    services:
                      kind === "service"
                        ? [
                            {
                              protocol: "tcp",
                              internalPort: 80,
                              autostop: "off",
                              checks: [cadenceCheck],
                            },
                          ]
                        : [],
                    deploy: { strategy: "bluegreen", healthTimeout: budget },
                  };
                  yield* Effect.gen(function* () {
                    const started = yield* Clock.currentTimeMillis;
                    const attempt = yield* deployWorker(
                      actor,
                      "two",
                      props,
                    ).pipe(Effect.scoped, Effect.result, Effect.forkScoped);
                    const checkName =
                      kind === "named" ? "ready" : "servicecheck-00-http-80";
                    const failed = yield* census(site.appName).pipe(
                      Effect.map((live) =>
                        live.find(
                          (machine) =>
                            !first.machineIds.includes(machine.id!) &&
                            machine.state === "started" &&
                            machine.checks?.some(
                              (check) =>
                                check.name === checkName &&
                                check.status === "critical",
                            ),
                        ),
                      ),
                      Effect.repeat({
                        schedule: Schedule.spaced("1 second"),
                        times: 120,
                        until: (machine) => machine !== undefined,
                      }),
                      Effect.timeout("150 seconds"),
                      Effect.raceFirst(
                        Effect.gen(function* () {
                          const result = yield* Fiber.join(attempt);
                          if (Result.isFailure(result))
                            return yield* Effect.fail(result.failure);
                          return yield* Effect.fail(
                            new Error(
                              "Candidate committed before a failing long-cadence report was observed",
                            ),
                          );
                        }),
                      ),
                    );
                    expect(failed).toBeDefined();
                    if (!failed)
                      return yield* Effect.fail(
                        new Error(
                          "Fly never emitted the initial failing cadence report",
                        ),
                      );
                    const nativeCheck =
                      kind === "named"
                        ? failed.config?.checks?.ready
                        : failed.config?.services?.[0]?.checks?.[0];
                    expect(
                      kind === "named"
                        ? ["75s", "1m15s"]
                        : ["60s", "1m0s", "1m"],
                    ).toContain(nativeCheck?.interval);
                    expect(["0s", "0", undefined]).toContain(
                      nativeCheck?.grace_period,
                    );
                    expect(failed.cordoned).toBe(true);
                    const failureReport = failed.checks!.find(
                      (check) => check.name === checkName,
                    )!;
                    expect(failureReport.updated_at).toBeDefined();
                    if (sufficient) {
                      const passing = yield* machines
                        .getMachine({
                          app_name: site.appName,
                          machine_id: failed.id!,
                        })
                        .pipe(
                          Effect.repeat({
                            schedule: Schedule.spaced("1 second"),
                            times: 120,
                            until: (machine) =>
                              machine.checks?.some(
                                (check) =>
                                  check.name === checkName &&
                                  check.status === "passing",
                              ) === true,
                          }),
                          Effect.timeout("120 seconds"),
                        );
                      const report = passing.checks?.find(
                        (check) => check.name === checkName,
                      );
                      expect(report?.status).toBe("passing");
                      expect(report?.updated_at).toBeDefined();
                      expect(failed.instance_id).toBeDefined();
                      expect(passing.instance_id).toBe(failed.instance_id);
                      const reportSpacing = yield* Effect.sync(
                        () =>
                          Date.parse(report!.updated_at!) -
                          Date.parse(failureReport.updated_at!),
                      );
                      expect(reportSpacing).toBeGreaterThan(60_000);
                      yield* Effect.logInfo(
                        "Native cadence reports across autonomous readiness transition",
                        {
                          reportSpacingMs: reportSpacing,
                          failingReport: failureReport.updated_at,
                          passingReport: report!.updated_at,
                        },
                      );
                      const result = yield* Fiber.join(attempt).pipe(
                        Effect.timeout("600 seconds"),
                      );
                      expect(Result.isSuccess(result)).toBe(true);
                      if (Result.isFailure(result))
                        return yield* Effect.fail(result.failure);
                      expect(result.success.machineIds).toEqual([failed.id]);
                      const committed = yield* assertCommitted(
                        site.appName,
                        result.success.machineIds,
                      );
                      expect(committed[0]!.instance_id).toBe(
                        failed.instance_id,
                      );
                      assertReadinessCommit(
                        proxy.readiness,
                        first.machineIds,
                        committed,
                        [0],
                        [checkName],
                        false,
                      );
                    } else {
                      const result = yield* Fiber.join(attempt).pipe(
                        Effect.timeout("180 seconds"),
                      );
                      expect(Result.isFailure(result)).toBe(true);
                      if (Result.isFailure(result))
                        expect(result.failure._tag).toBe(
                          "Fly.ReplicaChecksNotPassing",
                        );
                      expect(
                        (yield* Clock.currentTimeMillis) - started,
                      ).toBeLessThan(180_000);
                      const live = yield* census(site.appName);
                      expect(live.map((machine) => machine.id)).toEqual(
                        first.machineIds,
                      );
                      expect(live[0]!.state).toBe("started");
                      expect(live[0]!.cordoned).toBe(false);
                      expect(
                        proxy.events.some(
                          (event) =>
                            event.stage === "request" &&
                            first.machineIds.includes(event.machineId!) &&
                            (event.path.endsWith("/stop") ||
                              event.path.endsWith("/cordon") ||
                              event.path.endsWith("/suspend") ||
                              (event.path.endsWith("/metadata") &&
                                event.phase === "retiring") ||
                              (event.method === "DELETE" &&
                                /\/machines\/[^/]+$/.test(event.path))),
                        ),
                      ).toBe(false);
                      expect(
                        proxy.events.some(
                          (event) =>
                            event.machineId === failed.id &&
                            event.path.endsWith("/uncordon"),
                        ),
                      ).toBe(false);
                      expect(
                        proxy.readiness.some(
                          (event) =>
                            event.stage === "request" &&
                            event.machineId === failed.id &&
                            event.path.endsWith("/metadata") &&
                            event.phase === "active",
                        ),
                      ).toBe(false);
                    }
                    yield* Effect.logInfo("Live long-cadence evidence", {
                      kind,
                      interval: nativeCheck?.interval,
                      grace: nativeCheck?.grace_period,
                      budget,
                      firstFailure: failureReport.updated_at,
                      elapsedMs: (yield* Clock.currentTimeMillis) - started,
                    });
                  }).pipe(Effect.scoped);
                } finally {
                  yield* stack.destroy();
                  yield* assertAppGone(site.appName);
                }
              }).pipe(Effect.scoped),
            { timeout: 1_200_000 },
          );
        }
      }
    });
  },
);

describe.sequential(
  "ownership",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "S09 foreign routed Machine and sibling survive rollout and stale-instance deletion",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (version: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                const sibling = yield* Fly.Machine("Sibling", {
                  app,
                  image: "nginx:alpine",
                  env: { VERSION: "sibling" },
                });
                const worker = yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  env: { VERSION: version },
                  checks,
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "20 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                });
                return { sibling, worker };
              }),
            );
          const initial = yield* deploy("one");
          const foreign = yield* machines.createMachine({
            app_name: initial.worker.appName,
            name: "foreign-routed",
            region: "iad",
            config: {
              image: "nginx:alpine",
              env: { VERSION: "foreign" },
              services: [
                {
                  protocol: "tcp",
                  internal_port: 80,
                  ports: [{ port: 80, handlers: ["http"] }],
                },
              ],
            },
          });
          const removeForeign = machines
            .deleteMachine({
              app_name: initial.worker.appName,
              machine_id: foreign.id!,
              force: true,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* Effect.gen(function* () {
            const next = yield* deploy("two");
            expect(next.worker.machineId).not.toBe(initial.worker.machineId);
            expect(next.sibling.machineId).toBe(initial.sibling.machineId);
            const before = yield* census(initial.worker.appName);
            expect(before.map((machine) => machine.id).sort()).toEqual(
              [
                next.worker.machineId,
                next.sibling.machineId,
                foreign.id!,
              ].sort(),
            );
            expect(
              before.find((machine) => machine.id === foreign.id)?.cordoned,
            ).toBe(false);
            const owned = before.find(
              (machine) => machine.id === next.worker.machineId,
            )!;
            yield* deleteReplicaSet({
              appName: next.worker.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: owned.config!.metadata!["alchemy.fqn"]!,
              resourceInstanceId: "stale-instance-must-not-delete-successor",
              machineIds: next.worker.machineIds,
              volumeIds: [],
            });
            expect(
              (yield* census(initial.worker.appName))
                .map((machine) => machine.id)
                .sort(),
            ).toEqual(before.map((machine) => machine.id).sort());
          }).pipe(Effect.ensuring(removeForeign.pipe(Effect.orDie)));
          yield* stack.destroy();
          yield* assertAppGone(initial.worker.appName);
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "S09 F11 stale output and a same-logical-ID foreign FQN cannot authorize successor deletion",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (name: string, version: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  name,
                  image: "nginx:alpine",
                  checks,
                  env: { VERSION: version },
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "30 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                });
              }),
            );
          const initial = yield* deploy("stale-original", "one");
          const old = yield* machines.getMachine({
            app_name: initial.appName,
            machine_id: initial.machineId,
          });
          const oldMetadata = old.config!.metadata!;
          const collision = yield* machines.createMachine({
            app_name: initial.appName,
            name: "fqn-collision",
            region: "iad",
            config: {
              ...old.config,
              metadata: {
                ...oldMetadata,
                "alchemy.fqn": `${oldMetadata["alchemy.fqn"]}/OtherScope`,
              },
            },
          });
          yield* Effect.gen(function* () {
            const next = yield* deploy("stale-original", "two");
            const refreshed = yield* observeReplicaSet({
              appName: initial.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: oldMetadata["alchemy.fqn"]!,
              resourceInstanceId: oldMetadata["alchemy.instance"]!,
              baseName: initial.baseName,
              machineIds: [...initial.machineIds, collision.id!],
            });
            expect(refreshed?.machineIds).toEqual(next.machineIds);
            expect(refreshed?.rolloutPending).toBe(false);
            const successor = yield* deploy("stale-successor", "three");
            const current = yield* machines.getMachine({
              app_name: initial.appName,
              machine_id: successor.machineId,
            });
            expect(current.config?.metadata?.["alchemy.instance"]).not.toBe(
              oldMetadata["alchemy.instance"],
            );
            // Even an ID cache containing the new Machine grants no old-lineage authority.
            yield* deleteReplicaSet({
              appName: initial.appName,
              id: "Worker",
              type: "Fly.Machine",
              fqn: oldMetadata["alchemy.fqn"]!,
              resourceInstanceId: oldMetadata["alchemy.instance"]!,
              machineIds: [
                ...initial.machineIds,
                ...next.machineIds,
                ...successor.machineIds,
                collision.id!,
              ],
              volumeIds: [],
            });
            const live = yield* census(initial.appName);
            expect(live.map((machine) => machine.id).sort()).toEqual(
              [successor.machineId, collision.id!].sort(),
            );
            const foreign = live.find(
              (machine) => machine.id === collision.id,
            )!;
            expect(foreign.config?.metadata?.["alchemy.fqn"]).toBe(
              `${oldMetadata["alchemy.fqn"]}/OtherScope`,
            );
            expect(foreign.cordoned).toBe(false);
          }).pipe(
            Effect.ensuring(
              machines
                .deleteMachine({
                  app_name: initial.appName,
                  machine_id: collision.id!,
                  force: true,
                })
                .pipe(
                  Effect.catchTag("NotFound", () => Effect.void),
                  Effect.orDie,
                ),
            ),
          );
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }),
      { timeout: 600_000 },
    );
  },
);

describe.sequential(
  "post-promotion health",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:secret",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    describe.sequential("post-promotion health", () => {
      for (const changed of [false, true]) {
        test.provider(
          `F09 a real post-uncordon health flip preserves both generations then recovers ${changed ? "changed" : "same"} desired state`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const readiness = yield* makeReadinessControl();
              const initial = yield* readiness.deployWorker(stack, "one");
              const proxy = yield* transportProxy();
              yield* Effect.sync(() => {
                endpoint = proxy.url;
                proxy.arm({
                  match: (event) => event.path.endsWith("/uncordon"),
                  action: "hold-response",
                  remaining: 1,
                });
              });
              const update = yield* readiness
                .deployWorker(stack, "two")
                .pipe(Effect.result, Effect.forkScoped);
              const promoted = yield* proxy.wait(
                (event) =>
                  event.stage === "held" &&
                  event.path.endsWith("/uncordon") &&
                  event.status! < 300,
              );
              expect(promoted.machineId).toBeDefined();
              yield* readiness.turnOff(initial.appName, promoted.machineId!);
              yield* Effect.sync(proxy.release);
              const result = yield* Fiber.join(update).pipe(
                Effect.timeout("60 seconds"),
              );
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect(result.failure).toMatchObject({
                  _tag: "Fly.ReplicaChecksNotPassing",
                });
              const live = yield* census(initial.appName);
              expect(live.map((machine) => machine.id).sort()).toEqual(
                [initial.machineId, promoted.machineId!].sort(),
              );
              expect(live.every((machine) => machine.cordoned === false)).toBe(
                true,
              );
              const pending = live.find(
                (machine) => machine.id === promoted.machineId,
              )!;
              const metadata = pending.config!.metadata!;
              expect(metadata["alchemy.phase"]).toBe("validating");
              expect(metadata["alchemy.checked-instance"]).toBeUndefined();
              const read = yield* observeReplicaSet({
                appName: initial.appName,
                id: "Worker",
                type: "Fly.Machine",
                fqn: metadata["alchemy.fqn"]!,
                resourceInstanceId: metadata["alchemy.instance"]!,
                machineIds: initial.machineIds,
              });
              expect(read?.machineIds).toEqual(initial.machineIds);
              expect(read?.rolloutPending).toBe(true);
              expect(
                proxy.events.some(
                  (event) =>
                    event.method === "DELETE" &&
                    /\/machines\/[^/]+$/.test(event.path),
                ),
              ).toBe(false);
              if (!changed) {
                yield* repairReadiness(initial.appName, promoted.machineId!);
              }
              const recovered = yield* readiness.deployWorker(
                stack,
                changed ? "three" : "two",
              );
              if (changed)
                expect(recovered.machineId).not.toBe(promoted.machineId);
              else expect(recovered.machineId).toBe(promoted.machineId);
              yield* assertCommitted(initial.appName, recovered.machineIds);
              yield* Effect.sync(() => {
                endpoint = undefined;
              });
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  endpoint = undefined;
                }),
              ),
            ),
          { timeout: 300_000 },
        );
      }
    });
  },
);

describe.sequential(
  "process death",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const options = {
      providers: Fly.providers(),
      profile: "testing",
      dev: false,
      sidecar: false,
    };
    const { test } = Test.make(options);
    const selected = process.env.FLY_PROCESS_DEATH_CASE;

    const crash = (stack: Test.ScratchStack, title: string, phase: Phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* evidencePaths(stack);
        // Invalidate an earlier attempt before any cleanup or new cloud work.
        for (const file of [paths.witness, paths.finalized, paths.recovered]) {
          yield* fs.remove(file, { force: true });
        }
        yield* stack.destroy();
        const initial = yield* deploy(stack, "one").pipe(Effect.scoped);
        expect(initial.machineIds).toHaveLength(1);
        const predecessor = yield* identity(
          yield* machine(initial.appName, initial.machineId),
          stack,
        );
        expect(predecessor.phase).toBe("active");
        const proxy = yield* transportProxy();
        const actor = yield* Effect.sync(() =>
          scratchStack(
            {
              ...options,
              providers: throughProxy(() => proxy.url),
              stage: stack.stage,
            },
            title,
            processDeathFile,
          ),
        );
        expect(actor.name).toBe(stack.name);
        expect(actor.stage).toBe(stack.stage);
        expect(actor.state).not.toBe(stack.state);
        const match = (event: Parameters<typeof matchesBarrier>[3]) =>
          matchesBarrier(phase, initial.appName, predecessor.id, event);
        yield* Effect.sync(() =>
          proxy.arm({ match, action: "hold-response", remaining: 1 }),
        );
        const pid = yield* Effect.sync(() => process.pid);
        // Ordinary failure/interruption invalidates the attempt; SIGKILL cannot run this.
        yield* Effect.addFinalizer(() =>
          writeEvidence(paths.finalized, { pid, phase }).pipe(Effect.orDie),
        );
        const attempt = yield* deploy(actor, "two").pipe(
          Effect.scoped,
          Effect.forkScoped,
        );
        yield* Effect.gen(function* () {
          const barrier = yield* proxy.wait(
            (event) =>
              event.stage === "held" &&
              event.status !== undefined &&
              event.status >= 200 &&
              event.status < 300 &&
              match(event),
          );
          yield* Effect.gen(function* () {
            const live = yield* censusProcessDeath(initial.appName);
            const candidates = live.filter(
              (value) => value.id !== predecessor.id,
            );
            expect(candidates).toHaveLength(1);
            const candidate = yield* identity(
              yield* machine(initial.appName, candidates[0]!.id!),
              stack,
            );
            expect(candidate.generation).not.toBe(predecessor.generation);
            expect(candidate.workload).not.toBe(predecessor.workload);
            expect(Number(candidate.sequence)).toBe(
              Number(predecessor.sequence) + 1,
            );
            expect(candidate.instance).toBe(predecessor.instance);
            expect(candidate.fqn).toBe(predecessor.fqn);
            expect(barrier.machineId).toBe(
              phase === "retirement" ? predecessor.id : candidate.id,
            );
            const leases = yield* heldLeases(
              initial.appName,
              live.map((value) => value.id!),
            );
            expect(leases.map((value) => value.machineId).sort()).toEqual(
              (phase === "create"
                ? [predecessor.id]
                : phase === "promotion"
                  ? [predecessor.id, candidate.id]
                  : [candidate.id]
              ).sort(),
            );
            for (const held of leases) {
              expect(
                proxy.events.some(
                  (event) =>
                    event.stage === "completed" &&
                    event.method === "POST" &&
                    event.path.endsWith(`/machines/${held.machineId}/lease`) &&
                    event.status !== undefined &&
                    event.status >= 200 &&
                    event.status < 300,
                ),
              ).toBe(true);
            }
            const row = yield* persistedRow(stack, candidate.fqn);
            expect(row.instanceId).toBe(candidate.instance);
            expect(row.status).toBe("updating");
            const witness = {
              version: 1,
              signal: "SIGKILL",
              phase,
              pid,
              cwd: paths.cwd,
              stack: stack.name,
              stage: stack.stage,
              appName: initial.appName,
              recordedAt: yield* nowSeconds,
              predecessor,
              candidate,
              barrier: {
                sequence: barrier.sequence,
                method: barrier.method,
                path: barrier.path,
                status: barrier.status!,
                machineId: barrier.machineId!,
              },
              leases,
              row,
            } satisfies Witness;
            yield* assertBarrierInventory(stack, witness);
            yield* writeEvidence(paths.witness, witness);
            expect(yield* readWitness(paths.witness)).toEqual(witness);
            yield* Effect.sync(() => {
              expect(attempt.pollUnsafe() === undefined).toBe(true);
              expect(
                proxy.events.some(
                  (event) =>
                    event.sequence === barrier.sequence &&
                    ["forwarded", "dropped"].includes(event.stage),
                ),
              ).toBe(false);
              expect(
                proxy.events.some(
                  (event) =>
                    event.method === "DELETE" && event.path.endsWith("/lease"),
                ),
              ).toBe(false);
              expect(
                proxy.events.some(
                  (event) =>
                    event.stage === "request" &&
                    event.sequence > barrier.sequence &&
                    event.method !== "GET" &&
                    !event.path.endsWith("/lease"),
                ),
              ).toBe(false);
              expect(process.pid).toBe(witness.pid);
              process.kill(process.pid, "SIGKILL");
            });
            return yield* Effect.fail(
              new Error("SIGKILL returned without terminating the sole runner"),
            );
          }).pipe(Effect.timeout("20 seconds"));
        }).pipe(
          Effect.raceFirst(
            Fiber.join(attempt).pipe(
              Effect.andThen(
                Effect.fail(
                  new Error(
                    "Rollout finished before the process-death barrier",
                  ),
                ),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              proxy.clear();
              proxy.release();
            }),
          ),
        );
      }).pipe(Effect.scoped);

    const recover = (stack: Test.ScratchStack, phase: Phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* evidencePaths(stack);
        const witness = yield* readWitness(paths.witness);
        const pid = yield* Effect.sync(() => process.pid);
        expect(witness.pid).toBeGreaterThan(0);
        expect(pid).not.toBe(witness.pid);
        expect(witness.phase).toBe(phase);
        expect(witness.cwd).toBe(paths.cwd);
        expect(witness.stack).toBe(stack.name);
        expect(witness.stage).toBe(stack.stage);
        expect(yield* fs.exists(paths.finalized)).toBe(false);
        expect(yield* fs.exists(paths.recovered)).toBe(false);
        expect(witness.barrier.status).toBeGreaterThanOrEqual(200);
        expect(witness.barrier.status).toBeLessThan(300);
        expect(witness.barrier.sequence).toBeGreaterThan(0);
        expect(
          matchesBarrier(phase, witness.appName, witness.predecessor.id, {
            ...witness.barrier,
            stage: "held",
          }),
        ).toBe(true);
        expect(witness.barrier.machineId).toBe(
          phase === "retirement"
            ? witness.predecessor.id
            : witness.candidate.id,
        );
        expect(yield* persistedRow(stack, witness.row.fqn)).toEqual(
          witness.row,
        );
        expect(witness.row.status).toBe("updating");
        // No deploy, destroy, lease acquisition or release precedes the expiry observations.
        yield* assertBarrierInventory(stack, witness);
        const expiry = yield* observeLeaseExpiry(witness);
        yield* assertBarrierInventory(stack, witness);
        const recovered = yield* deploy(stack, "two").pipe(Effect.scoped);
        expect(recovered.appName).toBe(witness.appName);
        yield* assertConverged(stack, witness, recovered.machineIds);
        const unchanged = yield* deploy(stack, "two").pipe(Effect.scoped);
        expect(unchanged.machineIds).toEqual(recovered.machineIds);
        yield* assertConverged(stack, witness, unchanged.machineIds);
        yield* stack.destroy();
        yield* assertClean(stack, witness.appName);
        yield* writeEvidence(paths.recovered, {
          phase,
          crashPid: witness.pid,
          recoveryPid: pid,
          barrier: witness.barrier,
          expiry,
          machineIds: recovered.machineIds,
          generation: witness.candidate.generation,
          digest: witness.candidate.digest,
          cleaned: true,
        });
      });

    for (const phase of phases) {
      const skip =
        selected === undefined ||
        (phases.some((value) => value === selected) && selected !== phase);
      if (skip) {
        it.live.skip(
          `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 process death at completed ${phase}`,
          () => Effect.void,
        );
        continue;
      }
      // test.provider installs unconditional destroy-on-failure; preserve invalid recovery evidence instead.
      test(
        `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 process death at completed ${phase}`,
        Effect.gen(function* () {
          yield* assertSingleRunner;
          expect(selected).toBe(phase);
          const mode = process.env.FLY_PROCESS_DEATH_MODE;
          if (mode !== "crash" && mode !== "recovery") {
            return yield* Effect.fail(
              new Error("FLY_PROCESS_DEATH_MODE must be crash or recovery"),
            );
          }
          const stack = yield* Effect.sync(() =>
            scratchStack(
              options,
              `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 process death at completed ${phase}`,
              processDeathFile,
            ),
          );
          yield* withProviders(
            mode === "crash"
              ? crash(
                  stack,
                  `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 process death at completed ${phase}`,
                  phase,
                )
              : recover(stack, phase),
            options,
            stack.name,
          );
        }).pipe(Effect.scoped),
        { timeout: 500_000, retry: 0, exclusive: true },
      );
    }
  },
);

describe.sequential(
  "promotion faults",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    test.provider(
      "F03 F08 partial promotion loses the first uncordon response without rolling back serving green",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one", { count: 2 });
          const proxy = yield* transportProxy();
          const match = (event: { path: string }) =>
            event.path.endsWith("/uncordon");
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({ match, action: "drop-response", remaining: 1 });
            proxy.arm({ match, action: "cut-request", remaining: Infinity });
          });
          try {
            const failed = yield* deployWorker(stack, "two", { count: 2 }).pipe(
              Effect.timeout("120 seconds"),
              Effect.result,
            );
            expect(Result.isFailure(failed)).toBe(true);
            const lost = proxy.events.find(
              (event) =>
                event.stage === "dropped" && event.path.endsWith("/uncordon"),
            );
            expect(lost?.status).toBeGreaterThanOrEqual(200);
            expect(lost?.status).toBeLessThan(300);
            const live = yield* census(initial.appName);
            expect(
              initial.machineIds.every((id) =>
                live.some(
                  (machine) => machine.id === id && machine.cordoned === false,
                ),
              ),
            ).toBe(true);
            expect(
              live.find((machine) => machine.id === lost!.machineId)?.cordoned,
            ).toBe(false);
            const candidateIds = live
              .filter((machine) => !initial.machineIds.includes(machine.id!))
              .map((machine) => machine.id!);
            expect(candidateIds).toHaveLength(2);
            expect(
              proxy.events.some(
                (event) =>
                  event.method === "DELETE" &&
                  /\/machines\/[^/]+$/.test(event.path) &&
                  candidateIds.includes(event.machineId!),
              ),
            ).toBe(false);
            yield* Effect.sync(proxy.clear);
            const recovered = yield* deployWorker(stack, "two", { count: 2 });
            expect([...recovered.machineIds].sort()).toEqual(
              candidateIds.sort(),
            );
            yield* assertCommitted(initial.appName, recovered.machineIds);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 300_000 },
    );
  },
);

describe.sequential(
  "protocol branches",
  {
    tags: [
      "unit",
      "provider:fly",
      "provider:fly:machine",
      "provider:fly:service",
      "local",
    ],
  },
  () => {
    it.live(
      "S07 P actual SDK GET 408 decoder returns typed GatewayTimeout, not genuine remote 408",
      () =>
        Effect.gen(function* () {
          let requests = 0;
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              requests++;
              expect(request.method).toBe("GET");
              expect(new URL(request.url).pathname).toBe(
                `/v1/apps/${appName}/machines/${candidateId}`,
              );
              return reply(
                request,
                { error: "controlled request timeout" },
                408,
              );
            }),
          );
          const result = yield* machines
            .getMachine({ app_name: appName, machine_id: candidateId })
            .pipe(Retry.none, withControlledClient(client), Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(GatewayTimeoutErrors);
            expect(result.failure._tag).toBe("GatewayTimeout");
            if (result.failure._tag === "GatewayTimeout")
              expect(result.failure.message).toBe("controlled request timeout");
          }
          expect(requests).toBe(1);
        }),
    );

    it.live(
      "F02 P delayed visibility readback reuses one candidate without replaying create",
      () =>
        Effect.gen(function* () {
          const fixture = yield* protocolClient({
            conflict: true,
            hiddenLists: 2,
          });
          const result = yield* reconcile.pipe(
            withControlledClient(fixture.client),
          );
          expect(result.machineIds).toEqual([candidateId]);
          const lists = fixture.events.filter(
            (event) => event.visible !== undefined,
          );
          expect(lists.map((event) => event.visible)).toEqual([
            false,
            false,
            false,
            true,
          ]);
          const creates = fixture.events.filter(
            (event) =>
              event.method === "POST" && event.path.endsWith("/machines"),
          );
          expect(creates).toHaveLength(1);
          const visibleAt = fixture.events.indexOf(lists[3]!);
          const leaseAt = fixture.events.findIndex(
            (event) => event.method === "POST" && event.path.endsWith("/lease"),
          );
          const promotionAt = fixture.events.findIndex((event) =>
            event.path.endsWith("/uncordon"),
          );
          expect(leaseAt).toBeGreaterThan(visibleAt);
          expect(promotionAt).toBeGreaterThan(leaseAt);
          expect(
            fixture.events.filter((event) => event.phase === "active"),
          ).toHaveLength(1);
        }),
      { timeout: 30_000 },
    );

    it.live(
      "F02 P visibility exhaustion fails bounded readback without replay or promotion",
      () =>
        Effect.gen(function* () {
          const fixture = yield* protocolClient({
            conflict: true,
            hiddenLists: Infinity,
          });
          const result = yield* reconcile.pipe(
            withControlledClient(fixture.client),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(ReplicaNotCreated);
          expect(
            fixture.events.filter(
              (event) =>
                event.method === "POST" && event.path.endsWith("/machines"),
            ),
          ).toHaveLength(1);
          // Initial observation, nine bounded readback attempts, and failure-path observation.
          expect(
            fixture.events.filter((event) => event.visible === false),
          ).toHaveLength(11);
          expect(
            fixture.events.some(
              (event) =>
                event.path.endsWith("/lease") ||
                event.path.endsWith("/uncordon") ||
                event.method === "DELETE",
            ),
          ).toBe(false);
        }),
      { timeout: 30_000 },
    );

    for (const missing of ["image_ref", "digest", "repository"] as const) {
      it.live(
        `S08 P missing ${missing} refuses candidate promotion through the controller`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* protocolClient({ missingImageRef: missing });
            const result = yield* reconcile.pipe(
              withControlledClient(fixture.client),
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(
                DeploymentRecoveryAmbiguous,
              );
              if (result.failure._tag === "Fly.DeploymentRecoveryAmbiguous") {
                expect(result.failure.appName).toBe(appName);
                expect(result.failure.message).toBe(
                  `Candidate ${candidateId} changed before its lease was acquired. Mismatch: image_ref.`,
                );
              }
            }
            expect(
              fixture.events.some(
                (event) =>
                  event.method === "POST" && event.path.endsWith("/lease"),
              ),
            ).toBe(true);
            expect(
              fixture.events.some(
                (event) =>
                  event.path.endsWith("/metadata") ||
                  event.path.endsWith("/uncordon"),
              ),
            ).toBe(false);
            const current = yield* machines
              .getMachine({ app_name: appName, machine_id: candidateId })
              .pipe(withControlledClient(fixture.client));
            expect(current.cordoned).toBe(true);
            expect(current.config?.metadata?.[keys.phase]).toBe("candidate");
            if (missing === "image_ref")
              expect(current.image_ref).toBeUndefined();
            else expect(current.image_ref?.[missing]).toBeUndefined();
          }),
      );
    }

    const unreachable = (): machines.Machine => ({
      id: "controlled-unreachable",
      host_status: "unreachable",
      state: "started",
      config: { image: "fixture:latest", metadata, mounts: [] },
    });

    it.live(
      "F06 P owned stateless unreachable host skips lease/cordon/stop and force-deletes only with replacement ready",
      () =>
        Effect.gen(function* () {
          const target = unreachable();
          const events: Array<{
            method: string;
            path: string;
            force: string | undefined;
          }> = [];
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              const url = new URL(request.url);
              const path = url.pathname;
              events.push({
                method: request.method,
                path,
                force:
                  request.urlParams.params.find(
                    ([key]) => key === "force",
                  )?.[1] ??
                  url.searchParams.get("force") ??
                  undefined,
              });
              if (
                request.method === "DELETE" &&
                path.endsWith(`/machines/${target.id}`)
              )
                return reply(request, {});
              if (request.method === "GET" && path.endsWith("/wait"))
                return reply(request, { error: "not found" }, 404);
              throw new Error(
                `Unexpected unreachable-host request: ${request.method} ${path}`,
              );
            }),
          );
          yield* retireMachines(appName, [target], true).pipe(
            withControlledClient(client),
          );
          expect(events).toEqual([
            {
              method: "DELETE",
              path: `/v1/apps/${appName}/machines/${target.id}`,
              force: "true",
            },
            {
              method: "GET",
              path: `/v1/apps/${appName}/machines/${target.id}/wait`,
              force: undefined,
            },
          ]);
        }),
    );

    const unsafe: Array<{ name: string; machine: () => machines.Machine }> = [
      {
        name: "missing config",
        machine: () => ({ ...unreachable(), config: undefined }),
      },
      {
        name: "incomplete config",
        machine: () => ({
          ...unreachable(),
          incomplete_config: { image: "fixture:latest" },
        }),
      },
      {
        name: "mounted config",
        machine: () => ({
          ...unreachable(),
          config: {
            metadata,
            mounts: [{ volume: "vol-controlled", path: "/data" }],
          },
        }),
      },
      {
        name: "missing ownership instance",
        machine: () => ({
          ...unreachable(),
          config: { metadata: { ...metadata, [keys.instance]: undefined } },
        }),
      },
      {
        name: "missing ownership FQN",
        machine: () => ({
          ...unreachable(),
          config: { metadata: { ...metadata, [keys.fqn]: undefined } },
        }),
      },
    ];

    for (const variant of unsafe) {
      it.live(
        `F06 P unreachable host with ${variant.name} refuses force retirement`,
        () =>
          Effect.gen(function* () {
            let requests = 0;
            const client = HttpClient.make(() =>
              Effect.sync(() => {
                requests++;
                throw new Error(
                  "Unsafe unreachable target must not reach the transport",
                );
              }),
            );
            const target = variant.machine();
            const result = yield* retireMachines(appName, [target], true).pipe(
              withControlledClient(client),
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(
                ReplicaRetirementIncomplete,
              );
              if (result.failure._tag === "Fly.ReplicaRetirementIncomplete") {
                expect(result.failure.appName).toBe(appName);
                expect(result.failure.residuals).toEqual([
                  {
                    machineId: target.id,
                    stage: "Fly.ReplicaOwnershipChanged",
                  },
                ]);
              }
            }
            expect(requests).toBe(0);
          }),
      );
    }

    it.live(
      "F06 P unreachable host without replacement readiness cannot take the force-delete shortcut",
      () =>
        Effect.gen(function* () {
          const events: string[] = [];
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname;
              events.push(`${request.method} ${path}`);
              if (request.method === "POST" && path.endsWith("/lease"))
                return reply(
                  request,
                  { error: "controlled host unavailable" },
                  503,
                );
              throw new Error(
                `Unexpected unready retirement request: ${request.method} ${path}`,
              );
            }),
          );
          const result = yield* retireMachines(
            appName,
            [unreachable()],
            false,
          ).pipe(withControlledClient(client), Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (
            Result.isFailure(result) &&
            result.failure._tag === "Fly.ReplicaRetirementIncomplete"
          ) {
            expect(result.failure.residuals).toEqual([
              {
                machineId: "controlled-unreachable",
                stage: "ServiceUnavailable",
              },
            ]);
          } else {
            throw new Error(
              "Expected exact retirement residual for unavailable lease acquisition",
            );
          }
          expect(events).toEqual([
            `POST /v1/apps/${appName}/machines/controlled-unreachable/lease`,
          ]);
        }),
    );
  },
);

describe.sequential(
  "readiness oracle",
  {
    tags: [
      "unit",
      "provider:fly",
      "provider:fly:machine",
      "provider:fly:service",
      "local",
    ],
  },
  () => {
    const names = ["ready", "servicecheck-00-http-80"];
    const reports = (mirror = false) =>
      [...names, ...(mirror ? ["bg_deployments_compat-00-http-80"] : [])].map(
        (name) => ({ name, status: "passing" }),
      );

    // Synthetic journals exercise the oracle only; they are not native Fly evidence.
    const trace = (idle = true, retry = false, mirror = false) => {
      const events: ReadinessEvent[] = [];
      const path = (slot: number) => `/v1/apps/oracle/machines/green-${slot}`;
      const metadata = (
        slot: number,
        phase: string,
      ): Record<string, string> => ({
        "alchemy.stack": "oracle",
        "alchemy.stage": "pure",
        "alchemy.id": "Worker",
        "alchemy.type": "Fly.Machine",
        "alchemy.instance": "resource-instance",
        "alchemy.fqn": "Worker",
        "alchemy.replica": String(slot),
        "alchemy.generation": "generation",
        "alchemy.workload": "workload",
        "alchemy.image": "nginx@sha256:fixture",
        "alchemy.phase": phase,
        "alchemy.readiness-role": "run",
        "alchemy.readiness-roles": "run,run",
        "alchemy.idle-policy-restored": "true",
        ...(phase === "active"
          ? { "alchemy.checked-instance": `instance-${slot}` }
          : {}),
      });
      const request = (input: Omit<ReadinessEvent, "stage" | "sequence">) => {
        const event: ReadinessEvent = {
          ...input,
          stage: "request",
          sequence: events.length,
        };
        events.push(event);
        return event;
      };
      const reply = (
        input: ReadinessEvent,
        fields: Partial<ReadinessEvent> = {},
      ) => {
        const event: ReadinessEvent = {
          ...input,
          stage: "forwarded",
          status: 200,
          ...fields,
        };
        events.push(event);
        return event;
      };
      const read = (slot: number, phase: string, state: string) =>
        reply(
          request({
            method: "GET",
            path: path(slot),
            machineId: `green-${slot}`,
          }),
          {
            instanceId: `instance-${slot}`,
            digest: "sha256:fixture",
            state,
            cordoned: false,
            phase,
            metadata: metadata(slot, phase),
            checks: state === "started" ? reports(mirror) : [],
            services: [
              {
                protocol: "tcp",
                port: 80,
                autostop: "stop",
                autostart: true,
                floor: 0,
              },
            ],
          },
        );
      const stamp = (slot: number, phase: string) => {
        const input = {
          method: "PUT",
          path: `${path(slot)}/metadata`,
          machineId: `green-${slot}`,
          phase,
          metadata: metadata(slot, phase),
          metadataOnly: true,
        };
        if (retry)
          reply(request(input), { status: phase === "active" ? 503 : 429 });
        reply(request(input));
      };
      for (const slot of [0, 1]) {
        reply(
          request({
            method: "POST",
            path: path(slot),
            machineId: `green-${slot}`,
          }),
        );
        read(slot, "promoting", "started");
      }
      for (const slot of [0, 1]) stamp(slot, "validating");
      for (const slot of [0, 1])
        read(slot, "validating", idle && slot === 0 ? "stopped" : "started");
      for (const slot of [1, 0]) stamp(slot, "active");
      request({
        method: "POST",
        path: "/v1/apps/oracle/machines/old/cordon",
        machineId: "old",
      });
      const candidates: Machine[] = [0, 1].map((slot) => ({
        id: `green-${slot}`,
        instance_id: `instance-${slot}`,
        image_ref: { digest: "sha256:fixture" },
        state: idle && slot === 0 ? "stopped" : "started",
        cordoned: false,
        config: {
          metadata: metadata(slot, "active"),
          services: [
            {
              protocol: "tcp",
              internal_port: 80,
              autostop: "stop",
              autostart: true,
              min_machines_running: 0,
            },
          ],
        },
      }));
      return { events, candidates };
    };

    it.effect(
      "pure readiness trace accepts rejected resume only with fresh started-instance proof",
      () =>
        Effect.sync(() => {
          const rejectedStart = (status: number) => {
            const value = trace(false);
            const request: ReadinessEvent = {
              sequence: 999,
              stage: "request",
              method: "POST",
              path: "/v1/apps/oracle/machines/green-0/start",
              machineId: "green-0",
            };
            value.events.splice(2, 0, request, {
              ...request,
              stage: "forwarded",
              status,
            });
            return value;
          };
          expect(() => check(rejectedStart(412))).not.toThrow();
          expect(() => check(rejectedStart(500))).toThrow();
          const missing = rejectedStart(412);
          for (const event of missing.events)
            if (event.method === "GET" && event.machineId === "green-0")
              event.state = "stopped";
          expect(() => check(missing)).toThrow();
        }),
    );

    type Trace = ReturnType<typeof trace>;
    const check = ({ events, candidates }: Trace, allowIdle = true) =>
      assertReadinessCommit(
        events,
        ["old"],
        candidates,
        [0, 1],
        names,
        allowIdle,
      );
    const restored = ({ events }: Trace) =>
      events.find(
        (event) =>
          event.stage === "forwarded" &&
          event.method === "GET" &&
          event.machineId === "green-0" &&
          event.phase === "promoting",
      )!;
    const pending = ({ events }: Trace) =>
      events.find(
        (event) =>
          event.stage === "forwarded" &&
          event.method === "GET" &&
          event.machineId === "green-0" &&
          event.phase === "validating",
      )!;
    const active = ({ events }: Trace) =>
      events.filter(
        (event) =>
          event.method === "PUT" &&
          event.machineId === "green-0" &&
          event.phase === "active",
      );

    it.effect(
      "pure readiness matcher permits only passing corresponding mirrors",
      () =>
        Effect.sync(() => {
          expect(readinessChecksPassing(reports(), names)).toBe(true);
          expect(readinessChecksPassing(reports(true), names)).toBe(true);
          for (const invalid of [
            undefined,
            [],
            reports(true).filter(
              (check) => check.name !== "servicecheck-00-http-80",
            ),
            [...reports(), reports()[0]!],
            [...reports(true), reports(true).at(-1)!],
            [...reports(), { name: "unrelated", status: "passing" }],
            [
              ...reports(),
              { name: "bg_deployments_compat-00-tcp-80", status: "passing" },
            ],
            [...reports(), { name: undefined, status: "passing" }],
            reports(true).map((check) => ({ ...check, status: "warning" })),
            reports(true).map((check) =>
              check.name.startsWith("bg_")
                ? { ...check, status: "critical" }
                : check,
            ),
          ])
            expect(readinessChecksPassing(invalid, names)).toBe(false);
          expect(readinessChecksPassing(reports(), [...names, names[0]!])).toBe(
            false,
          );
        }),
    );

    it.effect(
      "pure readiness traces accept running and restored-idle proof with settled metadata retries",
      () =>
        Effect.sync(() => {
          for (const idle of [false, true]) {
            for (const retry of [false, true]) check(trace(idle, retry, true));
          }
          const suspended = trace();
          pending(suspended).state = "suspended";
          suspended.candidates[0]!.state = "suspended";
          check(suspended);
        }),
    );

    const invalidTraces: [string, (value: Trace) => void][] = [
      [
        "missing restored passing proof",
        (value) => {
          restored(value).checks = [];
        },
      ],
      [
        "proof from another instance",
        (value) => {
          restored(value).instanceId = "obsolete";
        },
      ],
      [
        "proof from another workload",
        (value) => {
          restored(value).metadata!["alchemy.workload"] = "obsolete";
        },
      ],
      [
        "proof with the preparation service policy",
        (value) => {
          restored(value).services![0]!.autostop = "off";
        },
      ],
      [
        "created representative",
        (value) => {
          pending(value).state = "created";
        },
      ],
      [
        "configuration mutation after restored proof",
        (value) => {
          const index = value.events.indexOf(restored(value)) + 1;
          const event: ReadinessEvent = {
            sequence: 10_000,
            stage: "request",
            method: "POST",
            path: "/v1/apps/oracle/machines/green-0",
            machineId: "green-0",
          };
          value.events.splice(index, 0, event, {
            ...event,
            stage: "forwarded",
            status: 200,
          });
        },
      ],
      [
        "GET requested before restoration completed",
        (value) => {
          const response = restored(value);
          const index = value.events.findIndex(
            (event) => event.sequence === response.sequence,
          );
          const [request] = value.events.splice(index, 1);
          value.events.splice(1, 0, request!);
        },
      ],
      [
        "changed pending metadata after proof",
        (value) => {
          for (const event of value.events.filter(
            (event) =>
              event.method === "PUT" &&
              event.machineId === "green-0" &&
              event.phase === "validating",
          )) {
            event.metadata = {
              ...event.metadata,
              "alchemy.checked-instance": "unproven",
            };
          }
        },
      ],
      [
        "conflicting commit retry",
        (value) => {
          const retry = active(value)
            .filter((event) => event.stage === "request")
            .at(-1)!;
          retry.metadata = {
            ...retry.metadata,
            "alchemy.checked-instance": "other",
          };
        },
      ],
      [
        "unsettled rejected attempt",
        (value) => {
          value.events.splice(value.events.indexOf(active(value)[1]!), 1);
        },
      ],
      [
        "retry begins before rejected receipt",
        (value) => {
          const attempts = active(value);
          const index = value.events.indexOf(attempts[2]!);
          value.events.splice(index, 1);
          value.events.splice(
            value.events.indexOf(attempts[1]!),
            0,
            attempts[2]!,
          );
        },
      ],
      [
        "terminal commit rejection",
        (value) => {
          active(value).at(-1)!.status = 429;
        },
      ],
      [
        "nonretryable metadata rejection",
        (value) => {
          active(value)[1]!.status = 403;
        },
      ],
      [
        "duplicate successful commit",
        (value) => {
          active(value)[1]!.status = 200;
        },
      ],
      [
        "replica zero starts committing before the other commit settles",
        (value) => {
          const response = value.events.find(
            (event) =>
              event.machineId === "green-1" &&
              event.phase === "active" &&
              event.stage === "forwarded" &&
              event.status === 200,
          )!;
          value.events.splice(value.events.indexOf(response), 1);
          value.events.splice(
            value.events.indexOf(active(value)[0]!) + 1,
            0,
            response,
          );
        },
      ],
      [
        "retirement before terminal commit receipt",
        (value) => {
          const retirement = value.events.pop()!;
          value.events.splice(
            value.events.indexOf(active(value).at(-1)!),
            0,
            retirement,
          );
        },
      ],
      [
        "commit before complete topology validation",
        (value) => {
          const first = value.events.findIndex(
            (event) => event.phase === "active",
          );
          const commit = value.events.splice(first, 4);
          const validation = value.events.findIndex(
            (event) =>
              event.method === "GET" &&
              event.machineId === "green-1" &&
              event.stage === "forwarded" &&
              event.phase === "validating",
          );
          value.events.splice(validation - 1, 0, ...commit);
        },
      ],
    ];

    for (const [name, corrupt] of invalidTraces) {
      it.effect(`pure readiness trace rejects ${name}`, () =>
        Effect.sync(() => {
          const value = trace(true, true);
          corrupt(value);
          expect(() => check(value)).toThrow();
        }),
      );
    }

    it.effect(
      "pure readiness trace refuses idle completion when autostop is disabled",
      () =>
        Effect.sync(() => {
          expect(() => check(trace(), false)).toThrow();
        }),
    );
  },
);

describe.sequential(
  "recovery",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });
    const checks = {
      ready: {
        type: "http" as const,
        port: 80,
        path: "/",
        interval: "2s",
        timeout: "1s",
      },
    };

    test.provider(
      "recovers partial promotion as one generation and preserves policy-only identity",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (healthTimeout: number) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  count: 2,
                  image: "nginx:alpine",
                  checks,
                  deploy: { strategy: "bluegreen", healthTimeout },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                });
              }),
            );
          const initial = yield* deploy(30_000);
          const source = yield* machines.getMachine({
            app_name: initial.appName,
            machine_id: initial.machineId,
          });
          const metadata = source.config!.metadata!;
          const candidates = [];
          for (let index = 0; index < 2; index++) {
            candidates.push(
              yield* machines.createMachine({
                app_name: initial.appName,
                name: `interrupted-promotion-${index}`,
                region: "iad",
                skip_service_registration: index !== 0,
                config: {
                  ...source.config,
                  image: metadata["alchemy.image"],
                  metadata: {
                    ...metadata,
                    "alchemy.generation": "interrupted",
                    "alchemy.sequence": "2",
                    "alchemy.replica": String(index),
                    "alchemy.phase": index === 0 ? "active" : "promoting",
                  },
                },
              }),
            );
          }
          const read = yield* observeReplicaSet({
            appName: initial.appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata["alchemy.fqn"]!,
            resourceInstanceId: metadata["alchemy.instance"]!,
            baseName: initial.baseName,
            machineIds: initial.machineIds,
          });
          expect(read?.machineIds).toEqual(initial.machineIds);
          expect(read?.count).toBe(2);
          expect(read?.rolloutPending).toBe(true);
          const recovered = yield* deploy(40_000);
          expect(recovered.machineIds).toEqual(
            candidates.map((machine) => machine.id),
          );
          expect(
            (yield* machines.listMachines({
              app_name: initial.appName,
            })).filter((machine) => machine.state !== "destroyed"),
          ).toHaveLength(2);
          const unchanged = yield* deploy(45_000);
          expect(unchanged.machineIds).toEqual(recovered.machineIds);
          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "rolling opt-out retires unfinished candidates without changing the surviving ID",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (strategy: "rolling" | "bluegreen") =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                const other = yield* Fly.Machine("Other", {
                  app,
                  image: "nginx:alpine",
                });
                const worker = yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  checks,
                  deploy: { strategy },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                });
                return { other, worker };
              }),
            );
          const initial = yield* deploy("bluegreen");
          const source = yield* machines.getMachine({
            app_name: initial.worker.appName,
            machine_id: initial.worker.machineId,
          });
          const candidate = yield* machines.createMachine({
            app_name: initial.worker.appName,
            name: "interrupted-candidate",
            region: "iad",
            config: {
              ...source.config,
              metadata: {
                ...source.config?.metadata,
                "alchemy.generation": "unfinished",
                "alchemy.sequence": "2",
                "alchemy.phase": "promoting",
              },
            },
          });
          const recovered = yield* deploy("rolling");
          expect(recovered.worker.machineId).toBe(initial.worker.machineId);
          expect(recovered.other.machineId).toBe(initial.other.machineId);
          const live = (yield* machines.listMachines({
            app_name: initial.worker.appName,
          })).filter((machine) => machine.state !== "destroyed");
          expect(live.map((machine) => machine.id).sort()).toEqual(
            [initial.worker.machineId, initial.other.machineId].sort(),
          );
          expect(live.some((machine) => machine.id === candidate.id)).toBe(
            false,
          );
          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "recovers partial preparation and isolates old engine-instance cleanup",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (healthTimeout: number) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  count: 2,
                  image: "nginx:alpine",
                  checks,
                  deploy: { strategy: "bluegreen", healthTimeout },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                });
              }),
            );
          const initial = yield* deploy(30_000);
          const source = yield* machines.getMachine({
            app_name: initial.appName,
            machine_id: initial.machineId,
          });
          const metadata = source.config!.metadata!;
          const candidate = yield* machines.createMachine({
            app_name: initial.appName,
            name: "interrupted-preparation",
            region: "iad",
            skip_service_registration: true,
            config: {
              ...source.config,
              image: metadata["alchemy.image"],
              metadata: {
                ...metadata,
                "alchemy.generation": "interrupted",
                "alchemy.sequence": "2",
                "alchemy.replica": "0",
                "alchemy.phase": "candidate",
              },
            },
          });
          const read = yield* observeReplicaSet({
            appName: initial.appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata["alchemy.fqn"]!,
            resourceInstanceId: metadata["alchemy.instance"]!,
            baseName: initial.baseName,
            machineIds: initial.machineIds,
          });
          expect(read?.machineIds).toEqual(initial.machineIds);
          expect(read?.rolloutPending).toBe(true);
          const recovered = yield* deploy(40_000);
          expect(recovered.machineIds[0]).toBe(candidate.id);
          expect(recovered.machineIds).toHaveLength(2);
          yield* deleteReplicaSet({
            appName: initial.appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata["alchemy.fqn"]!,
            resourceInstanceId: "previous-engine-instance",
            machineIds: recovered.machineIds,
            volumeIds: [],
          });
          const live = (yield* machines.listMachines({
            app_name: initial.appName,
          })).filter((machine) => machine.state !== "destroyed");
          expect(live.map((machine) => machine.id).sort()).toEqual(
            [...recovered.machineIds].sort(),
          );
          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "replaces the entire generation when one replica drifts",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (healthTimeout: number, count = 2) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                return yield* Fly.Machine("Worker", {
                  app,
                  count,
                  image: "nginx:alpine",
                  checks,
                  deploy: { strategy: "bluegreen", healthTimeout },
                  shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                });
              }),
            );
          const initial = yield* deploy(30_000);
          const target = {
            app_name: initial.appName,
            machine_id: initial.machineIds[1]!,
          };
          const source = yield* machines.getMachine(target);
          const drifted = yield* machines.updateMachine({
            ...target,
            config: { ...source.config, env: { DRIFT: "true" } },
          });
          expect(drifted.config?.env?.DRIFT).toBe("true");
          const observed = yield* machines
            .listMachines({ app_name: initial.appName })
            .pipe(
              Effect.map((listed) =>
                listed.find((machine) => machine.id === target.machine_id),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (machine) =>
                  machine?.state === "started" &&
                  machine.config?.env?.DRIFT === "true",
                times: 10,
              }),
            );
          expect(observed?.config?.env?.DRIFT).toBe("true");
          expect(observed?.state).toBe("started");
          const recovered = yield* deploy(40_000);
          expect(
            recovered.machineIds.every(
              (id) => !initial.machineIds.includes(id),
            ),
          ).toBe(true);
          const live = (yield* machines.listMachines({
            app_name: initial.appName,
          })).filter((machine) => machine.state !== "destroyed");
          expect(live).toHaveLength(2);
          expect(
            live.every((machine) => machine.config?.env?.DRIFT === undefined),
          ).toBe(true);
          expect(
            new Set(live.map((machine) => machine.image_ref?.digest)).size,
          ).toBe(1);
          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );
  },
);

describe.sequential(
  "required metadata writes",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    const props = {
      count: 2,
      deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
    } as const;

    test.provider(
      "F05 real required promotion-intent write fault forbids every uncordon and early old deletion",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one", props);
          const proxy = yield* transportProxy();
          try {
            yield* Effect.sync(() => {
              endpoint = proxy.url;
              proxy.arm({
                match: (event) =>
                  event.method === "PUT" &&
                  event.path.endsWith("/metadata") &&
                  event.phase === "promoting",
                action: "cut-request",
                remaining: Infinity,
              });
            });
            const result = yield* deployWorker(stack, "two", props).pipe(
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({
                _tag: "Fly.MachineMutationUncertain",
              });
            const cut = proxy.events.filter(
              (event) => event.stage === "cut" && event.phase === "promoting",
            );
            expect(cut.length).toBeGreaterThan(0);
            expect(new Set(cut.map((event) => event.machineId)).size).toBe(1);
            const live = yield* census(initial.appName);
            const old = live.filter((machine) =>
              initial.machineIds.includes(machine.id!),
            );
            const candidates = live.filter(
              (machine) => !initial.machineIds.includes(machine.id!),
            );
            expect(old.map((machine) => machine.id).sort()).toEqual(
              [...initial.machineIds].sort(),
            );
            expect(
              old.every(
                (machine) =>
                  machine.cordoned === false && machine.state === "started",
              ),
            ).toBe(true);
            expect(candidates).toHaveLength(2);
            expect(
              candidates.every(
                (machine) =>
                  machine.cordoned === true &&
                  machine.config?.metadata?.["alchemy.phase"] === "candidate",
              ),
            ).toBe(true);
            expect(
              candidates.some((machine) => machine.id === cut[0]!.machineId),
            ).toBe(true);
            expect(
              proxy.events.some((event) => event.path.endsWith("/uncordon")),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  initial.machineIds.includes(event.machineId!) &&
                  (event.path.endsWith("/cordon") ||
                    event.path.endsWith("/stop") ||
                    (event.method === "DELETE" &&
                      /\/machines\/[^/]+$/.test(event.path))),
              ),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.phase === "active" || event.phase === "retiring",
              ),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.method === "DELETE" &&
                  /\/machines\/[^/]+$/.test(event.path),
              ),
            ).toBe(false);
            const candidateIds = candidates
              .map((machine) => machine.id!)
              .sort();
            yield* Effect.sync(proxy.clear);
            const recovered = yield* deployWorker(stack, "two", props);
            expect([...recovered.machineIds].sort()).toEqual(candidateIds);
            yield* assertCommitted(initial.appName, recovered.machineIds);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 900_000 },
    );
  },
);

describe.sequential(
  "retirement residuals",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });
    const props = {
      count: 2,
      deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
    } as const;

    describe.sequential("real retirement residual diagnostics", () => {
      for (const operation of ["cordon", "stop", "delete"] as const) {
        test.provider(
          `F04 real ${operation} transport fault reports exact target/stage while sibling retirement completes`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const initial = yield* deployWorker(stack, "one", props);
              const [targetId, siblingId] = [...initial.machineIds].sort();
              expect(initial.machineIds).toHaveLength(2);
              const proxy = yield* transportProxy();
              try {
                yield* Effect.sync(() => {
                  endpoint = proxy.url;
                  proxy.arm({
                    match: (event) =>
                      event.machineId === targetId &&
                      (operation === "delete"
                        ? event.method === "DELETE" &&
                          event.path.endsWith(`/machines/${targetId}`)
                        : event.method === "POST" &&
                          event.path.endsWith(`/${operation}`)),
                    action: "cut-request",
                    remaining: Infinity,
                  });
                });
                const result = yield* deployWorker(stack, "two", props).pipe(
                  Effect.result,
                );
                expect(Result.isFailure(result)).toBe(true);
                if (Result.isFailure(result)) {
                  expect(result.failure).toBeInstanceOf(
                    ReplicaRetirementIncomplete,
                  );
                  if (result.failure instanceof ReplicaRetirementIncomplete) {
                    expect(result.failure.appName).toBe(initial.appName);
                    expect(result.failure.residuals).toEqual([
                      {
                        machineId: targetId,
                        stage: `${operation}: Fly.MachineMutationUncertain`,
                      },
                    ]);
                  }
                }
                const cuts = proxy.events.filter(
                  (event) => event.stage === "cut",
                );
                expect(cuts.length).toBeGreaterThan(0);
                expect([
                  ...new Set(cuts.map((event) => event.machineId)),
                ]).toEqual([targetId]);
                const live = yield* census(initial.appName);
                const old = live.filter((machine) =>
                  initial.machineIds.includes(machine.id!),
                );
                const green = live.filter(
                  (machine) => !initial.machineIds.includes(machine.id!),
                );
                expect(old.map((machine) => machine.id)).toEqual([targetId]);
                expect(live.some((machine) => machine.id === siblingId)).toBe(
                  false,
                );
                expect(old[0]!.cordoned).toBe(operation !== "cordon");
                expect(old[0]!.state).toBe(
                  operation === "delete" ? "stopped" : "started",
                );
                expect(green).toHaveLength(2);
                expect(
                  green.every(
                    (machine) =>
                      machine.cordoned === false &&
                      machine.config?.metadata?.["alchemy.phase"] === "active",
                  ),
                ).toBe(true);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.machineId === siblingId &&
                      event.method === "DELETE" &&
                      event.path.endsWith(`/machines/${siblingId}`) &&
                      event.status! >= 200 &&
                      event.status! < 300,
                  ),
                ).toBe(true);
                const greenIds = green.map((machine) => machine.id!).sort();
                expect(live.map((machine) => machine.id).sort()).toEqual(
                  [...greenIds, targetId].sort(),
                );
                yield* Effect.sync(proxy.clear);
                const recovered = yield* deployWorker(stack, "two", props);
                expect([...recovered.machineIds].sort()).toEqual(greenIds);
                yield* assertCommitted(initial.appName, recovered.machineIds);
                expect(
                  (yield* census(initial.appName)).some((machine) =>
                    initial.machineIds.includes(machine.id!),
                  ),
                ).toBe(false);
              } finally {
                yield* Effect.sync(() => {
                  endpoint = undefined;
                  proxy.clear();
                });
              }
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  endpoint = undefined;
                }),
              ),
            ),
          { timeout: 900_000 },
        );
      }
    });
  },
);

describe.sequential(
  "retirement faults",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    describe.sequential("retirement faults", () => {
      test.provider(
        "F04 a real second remover accepts terminal success or typed NotFound and destroy stays idempotent",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const initial = yield* deployWorker(stack, "one");
            const target = {
              app_name: initial.appName,
              machine_id: initial.machineId,
              force: true,
            };
            yield* machines.deleteMachine(target).pipe(Retry.none);
            const removedAgain = yield* machines
              .deleteMachine(target)
              .pipe(Retry.none, Effect.result);
            if (Result.isFailure(removedAgain))
              expect(removedAgain.failure._tag).toBe("NotFound");
            const absent = yield* machines
              .getMachine({
                app_name: target.app_name,
                machine_id: target.machine_id,
              })
              .pipe(
                Retry.none,
                Effect.map(
                  (machine) =>
                    machine.id === target.machine_id &&
                    machine.state === "destroyed",
                ),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
                Effect.repeat({
                  times: 8,
                  schedule: Schedule.spaced("2 seconds"),
                  until: (gone) => gone,
                }),
                Effect.timeout("30 seconds"),
              );
            expect(absent).toBe(true);
            yield* Effect.logInfo("Observed real second-remover outcome", {
              appName: initial.appName,
              machineId: initial.machineId,
              outcome: Result.isSuccess(removedAgain)
                ? "accepted"
                : removedAgain.failure._tag,
              absenceConfirmed: absent,
            });
            expect(yield* census(initial.appName)).toHaveLength(0);
            yield* stack.destroy();
            yield* assertAppGone(initial.appName);
            yield* stack.destroy();
          }),
        { timeout: 180_000 },
      );
      test.provider(
        "FLY-REVIEW-2 lost successful DELETE does not cancel a sibling draining across renewal",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const props = {
              count: 2,
              shutdown: { signal: "SIGTERM", timeout: "90 seconds" },
              init: {
                exec: [
                  "/bin/sh",
                  "-c",
                  "trap 'if [ -f /slow-drain ]; then sleep 60; fi; exit 0' TERM; nginx -g 'daemon off;' & while :; do sleep 1 & wait $!; done",
                ],
              },
            } satisfies Partial<
              Omit<Extract<MachineProps, { image: string }>, "app">
            >;
            const initial = yield* deployWorker(stack, "one", props);
            const [fastId, slowId] = [...initial.machineIds].sort();
            expect(initial.machineIds).toHaveLength(2);
            const configured = yield* machines.execMachine({
              app_name: initial.appName,
              machine_id: slowId!,
              command: ["touch", "/slow-drain"],
              timeout: 5,
            });
            expect(configured.exit_code).toBe(0);
            const proxy = yield* transportProxy();
            const isFastDelete = (event: TransportEvent) =>
              event.machineId === fastId &&
              event.method === "DELETE" &&
              event.path.endsWith(`/machines/${fastId}`);
            yield* Effect.sync(() => {
              endpoint = proxy.url;
              proxy.arm({
                match: isFastDelete,
                action: "drop-response",
                remaining: 1,
              });
              proxy.arm({
                match: isFastDelete,
                action: "cut-request",
                remaining: Infinity,
              });
            });
            const update = yield* deployWorker(stack, "two", props).pipe(
              Effect.result,
              Effect.forkScoped,
            );
            const dropped = yield* proxy.wait(
              (event) =>
                isFastDelete(event) &&
                event.stage === "dropped" &&
                event.status! >= 200 &&
                event.status! < 300,
            );
            const deletedAt = yield* Clock.currentTimeMillis;
            // The real old process remains in its shutdown trap across the 25-second renewal tick.
            yield* Effect.sleep("30 seconds");
            const draining = yield* machines.getMachine({
              app_name: initial.appName,
              machine_id: slowId!,
            });
            expect(draining.state).not.toBe("destroyed");
            expect(
              (yield* Clock.currentTimeMillis) - deletedAt,
            ).toBeGreaterThanOrEqual(30_000);
            expect(
              proxy.events.some(
                (event) =>
                  event.sequence > dropped.sequence &&
                  event.stage === "completed" &&
                  event.method === "POST" &&
                  event.machineId === slowId &&
                  event.path.endsWith("/lease") &&
                  event.status! >= 200 &&
                  event.status! < 300,
              ),
            ).toBe(true);
            const result = yield* Fiber.join(update).pipe(
              Effect.timeout("240 seconds"),
            );
            expect(Result.isSuccess(result)).toBe(true);
            if (Result.isSuccess(result))
              yield* assertCommitted(
                initial.appName,
                result.success.machineIds,
              );
            const live = yield* census(initial.appName);
            expect(live).toHaveLength(2);
            expect(
              live.every(
                (machine) => !initial.machineIds.includes(machine.id!),
              ),
            ).toBe(true);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.method === "GET" &&
                  event.path.endsWith(`/machines/${fastId}`) &&
                  event.sequence > dropped.sequence &&
                  (event.status === 404 || event.state === "destroyed"),
              ),
            ).toBe(true);
            yield* Effect.logInfo(
              "Exact-target retirement transport evidence",
              {
                machineId: fastId,
                events: proxy.events.filter(
                  (event) =>
                    isFastDelete(event) ||
                    (event.method === "GET" &&
                      event.path.endsWith(`/machines/${fastId}`)),
                ),
              },
            );
            expect(
              proxy.events.some(
                (event) =>
                  isFastDelete(event) &&
                  event.stage === "request" &&
                  event.sequence > dropped.sequence,
              ),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.machineId === slowId &&
                  event.method === "DELETE" &&
                  event.path.endsWith(`/machines/${slowId}`) &&
                  event.status! >= 200 &&
                  event.status! < 300,
              ),
            ).toBe(true);
            yield* Effect.sync(() => {
              proxy.clear();
              endpoint = undefined;
            });
            yield* stack.destroy();
            yield* assertAppGone(initial.appName);
          }).pipe(
            Effect.scoped,
            Effect.ensuring(
              Effect.sync(() => {
                endpoint = undefined;
              }),
            ),
          ),
        { timeout: 600_000 },
      );

      for (const operation of ["cordon", "stop", "delete"] as const) {
        test.provider(
          `F04 completed ${operation} response loss preserves green and recovers residuals`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const initial = yield* deployWorker(stack, "one");
              const proxy = yield* transportProxy();
              const match = (event: TransportEvent) =>
                event.machineId === initial.machineId &&
                (operation === "delete"
                  ? event.method === "DELETE" &&
                    event.path.endsWith(initial.machineId)
                  : event.path.endsWith(`/${operation}`));
              yield* Effect.sync(() => {
                endpoint = proxy.url;
                proxy.arm({ match, action: "drop-response", remaining: 1 });
                proxy.arm({
                  match,
                  action: "cut-request",
                  remaining: Infinity,
                });
              });
              const result = yield* deployWorker(stack, "two").pipe(
                Effect.timeout("120 seconds"),
                Effect.result,
              );
              expect(
                proxy.events.some(
                  (event) => event.stage === "dropped" && event.status! < 300,
                ),
              ).toBe(true);
              const live = yield* census(initial.appName);
              const green = live.filter(
                (machine) => machine.id !== initial.machineId,
              );
              expect(green).toHaveLength(1);
              expect(green[0]!.cordoned).toBe(false);
              expect(green[0]!.config?.metadata?.["alchemy.phase"]).toBe(
                "active",
              );
              if (live.some((machine) => machine.id === initial.machineId))
                expect(Result.isFailure(result)).toBe(true);
              yield* Effect.sync(proxy.clear);
              const recovered = yield* deployWorker(stack, "two");
              expect(recovered.machineIds).toEqual(
                green.map((machine) => machine.id),
              );
              yield* assertCommitted(initial.appName, recovered.machineIds);
              yield* Effect.sync(() => {
                endpoint = undefined;
              });
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  endpoint = undefined;
                }),
              ),
            ),
          { timeout: 300_000 },
        );
      }

      for (const phase of ["retiring", "active"] as const) {
        test.provider(
          `F05 ${phase === "retiring" ? "advisory old" : "required commit"} metadata connection failure`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const initial = yield* deployWorker(stack, "one");
              const proxy = yield* transportProxy();
              yield* Effect.sync(() => {
                endpoint = proxy.url;
                proxy.arm({
                  match: (event) =>
                    event.path.endsWith("/metadata") && event.phase === phase,
                  action: "cut-request",
                  remaining: Infinity,
                });
              });
              const result = yield* deployWorker(stack, "two").pipe(
                Effect.timeout("120 seconds"),
                Effect.result,
              );
              expect(
                proxy.events.some(
                  (event) => event.stage === "cut" && event.phase === phase,
                ),
              ).toBe(true);
              const live = yield* census(initial.appName);
              const green = live.filter(
                (machine) => machine.id !== initial.machineId,
              );
              expect(green).toHaveLength(1);
              expect(green[0]!.cordoned).toBe(false);
              if (phase === "retiring") {
                expect(Result.isSuccess(result)).toBe(true);
                expect(
                  live.some((machine) => machine.id === initial.machineId),
                ).toBe(false);
              } else {
                expect(Result.isFailure(result)).toBe(true);
                expect(
                  live.find((machine) => machine.id === initial.machineId)
                    ?.cordoned,
                ).toBe(false);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.machineId === initial.machineId &&
                      ["POST", "DELETE"].includes(event.method) &&
                      !event.path.endsWith("/lease"),
                  ),
                ).toBe(false);
              }
              yield* Effect.sync(proxy.clear);
              const recovered = yield* deployWorker(stack, "two");
              expect(recovered.machineIds).toEqual(
                green.map((machine) => machine.id),
              );
              yield* assertCommitted(initial.appName, recovered.machineIds);
              yield* Effect.sync(() => {
                endpoint = undefined;
              });
              yield* stack.destroy();
              yield* assertAppGone(initial.appName);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  endpoint = undefined;
                }),
              ),
            ),
          { timeout: 300_000 },
        );
      }
    });
  },
);

describe.sequential(
  "runtime secrets",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:secret",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    class WriterProbeFailed extends Data.TaggedError("WriterProbeFailed")<{
      stage: "transport" | "status" | "decode";
      status?: number;
    }> {}

    const Receipt = Schema.Struct({
      version: Schema.Number,
      machineId: Schema.String,
      marker: Schema.Literals(["ready", "three"]),
    });

    const probeWriter = (
      appName: string,
      token: Redacted.Redacted<string>,
      method: "GET" | "POST",
    ) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const url = `https://${appName}.fly.dev/writer`;
        const request = (
          method === "POST"
            ? HttpClientRequest.post(url)
            : HttpClientRequest.get(url)
        ).pipe(HttpClientRequest.bearerToken(token));
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              () => new WriterProbeFailed({ stage: "transport" }),
            ),
          );
        if (response.status !== 200) {
          return yield* new WriterProbeFailed({
            stage: "status",
            status: response.status,
          });
        }
        return yield* response.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Receipt, { onExcessProperty: "error" }),
          ),
          Effect.mapError(() => new WriterProbeFailed({ stage: "decode" })),
        );
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new WriterProbeFailed({ stage: "transport" })),
        ),
      );

    const marker = (appName: string, machineId: string) =>
      machines
        .execMachine({
          app_name: appName,
          machine_id: machineId,
          command: ["cat", "/usr/share/nginx/html/marker"],
          timeout: 5,
        })
        .pipe(
          Effect.map((response) => {
            const value = response.stdout?.trim();
            return {
              code: response.exit_code,
              marker: value === "two" || value === "three" ? value : "missing",
            };
          }),
        );

    test.provider(
      "F12 deployed sibling runtime writer advances the shared vault during a held candidate create",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const proxy = yield* transportProxy();
          let appName: string | undefined;
          yield* Effect.addFinalizer(() =>
            stack.destroy().pipe(
              Effect.andThen(() =>
                appName === undefined ? Effect.void : assertAppGone(appName),
              ),
              Effect.orDie,
            ),
          );
          const actor = yield* engineActor(
            stack,
            "F12 deployed sibling runtime writer advances the shared vault during a held candidate create",
            "test/Fly/BlueGreen.test.ts",
            proxy.url,
          );
          const trigger = yield* Effect.sync(() =>
            Redacted.make(
              Array.from(randomBytes(32), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            ),
          );
          const deploy = (count: number, floor?: number) =>
            actor.deploy(
              Effect.gen(function* () {
                const app = yield* Site;
                const secret = yield* Token;
                const auth = yield* Fly.Secret("WriterTrigger", {
                  app,
                  name: TRIGGER_SECRET,
                  value: trigger,
                });
                yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                const writer = yield* Writer.pipe(
                  Effect.provide(writerLayer(auth.digest)),
                );
                const consumer = yield* Fly.Machine("Consumer", {
                  app,
                  region: "iad",
                  image: "nginx:alpine",
                  count,
                  minSecretsVersion: floor,
                  env: { SECRET_RESOURCE_NAME: secret.name },
                  init: {
                    exec: [
                      "/bin/sh",
                      "-c",
                      "case \"$ACCEPTANCE_RUNTIME_SECRET\" in *-two) marker=two;; *-three) marker=three;; *) marker=missing;; esac; printf '%s' \"$marker\" > /usr/share/nginx/html/marker; exec nginx -g 'daemon off;'",
                    ],
                  },
                  checks,
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "60 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                });
                return { app, secret, writer, consumer };
              }),
            );

          const initial = yield* deploy(1);
          appName = initial.app.appName;
          expect(initial.writer.machineIds).toHaveLength(1);
          expect(initial.consumer.machineIds).toHaveLength(1);
          expect(initial.consumer.imageRef?.digest).toBeTruthy();
          expect(yield* marker(appName, initial.consumer.machineId)).toEqual({
            code: 0,
            marker: "two",
          });
          const before = yield* probeWriter(appName, trigger, "GET").pipe(
            Effect.retry({
              while: (error) =>
                error.stage === "transport" ||
                (error.stage === "status" &&
                  [404, 502, 503].includes(error.status ?? 0)),
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
            Effect.timeout("90 seconds"),
          );
          expect(before).toEqual({
            version: 0,
            machineId: initial.writer.machineId,
            marker: "ready",
          });
          const client = yield* HttpClient.HttpClient;
          const unauthorized = yield* client
            .post(`https://${appName}.fly.dev/writer`)
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                () => new WriterProbeFailed({ stage: "transport" }),
              ),
            );
          expect(unauthorized.status).toBe(401);
          const initialCensus = yield* census(appName);
          expect(initialCensus.map((machine) => machine.id).sort()).toEqual(
            [
              ...initial.writer.machineIds,
              ...initial.consumer.machineIds,
            ].sort(),
          );
          const writerBefore = initialCensus.find(
            (machine) => machine.id === initial.writer.machineId,
          );
          expect(writerBefore?.instance_id).toBeTruthy();
          expect(writerBefore?.image_ref?.digest).toBeTruthy();
          const secretWrites = proxy.events.filter(
            (event) =>
              event.stage === "completed" &&
              event.method === "POST" &&
              event.path.startsWith(`/v1/apps/${appName}/secrets`) &&
              event.status !== undefined &&
              event.status >= 200 &&
              event.status < 300 &&
              event.secretsVersion !== undefined,
          );
          expect(secretWrites.length).toBeGreaterThan(0);
          const floor = Math.max(
            ...secretWrites.map((event) => event.secretsVersion!),
          );
          expect(Number.isSafeInteger(floor)).toBe(true);
          expect(floor).toBeGreaterThan(0);
          const start = proxy.events.length;
          const machinePath = `/v1/apps/${appName}/machines`;
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) =>
                event.method === "POST" &&
                event.path === machinePath &&
                event.phase === "candidate",
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const rollout = yield* deploy(2, floor).pipe(
              Effect.scoped,
              Effect.forkScoped,
            );
            const held = yield* proxy.wait(
              (event) =>
                event.stage === "held" &&
                event.path === machinePath &&
                event.status !== undefined &&
                event.status >= 200 &&
                event.status < 300,
            );
            expect(held.machineId).toBeTruthy();
            expect(held.minSecretsVersion).toBe(floor);
            // This POST runs the existing WriteSecret binding inside the sibling Machine.
            const later = yield* probeWriter(
              initial.app.appName,
              trigger,
              "POST",
            );
            expect(later.machineId).toBe(initial.writer.machineId);
            expect(later.marker).toBe("three");
            expect(Number.isSafeInteger(later.version)).toBe(true);
            expect(later.version).toBeGreaterThan(floor);
            expect(
              proxy.events.some(
                (event) =>
                  event.sequence === held.sequence &&
                  event.stage === "forwarded",
              ),
            ).toBe(false);
            yield* Effect.sync(proxy.release);
            const next = yield* Fiber.join(rollout).pipe(
              Effect.timeout("240 seconds"),
            );
            expect(next.app.appName).toBe(initial.app.appName);
            expect(next.secret.name).toBe(initial.secret.name);
            expect(next.writer.machineIds).toEqual(initial.writer.machineIds);
            expect(next.consumer.machineIds).toHaveLength(2);
            expect(next.consumer.machineIds).toContain(held.machineId);
            expect(next.consumer.machineIds).not.toContain(
              initial.consumer.machineId,
            );
            const events = proxy.events.slice(start);
            const creates = events.filter(
              (event) =>
                event.stage === "request" &&
                event.method === "POST" &&
                event.path === machinePath,
            );
            expect(creates).toHaveLength(2);
            expect(creates[0]?.sequence).toBe(held.sequence);
            expect(
              creates.every((event) => event.minSecretsVersion === floor),
            ).toBe(true);
            const released = events.findIndex(
              (event) =>
                event.sequence === held.sequence && event.stage === "forwarded",
            );
            expect(released).toBeGreaterThan(-1);
            expect(events.indexOf(creates[1]!)).toBeGreaterThan(released);
            expect(
              events.some(
                (event) =>
                  event.stage === "request" &&
                  event.machineId === initial.writer.machineId &&
                  event.method !== "GET",
              ),
            ).toBe(false);
            const live = yield* census(initial.app.appName);
            expect(live.map((machine) => machine.id).sort()).toEqual(
              [...next.writer.machineIds, ...next.consumer.machineIds].sort(),
            );
            const writerAfter = live.find(
              (machine) => machine.id === initial.writer.machineId,
            );
            expect(writerAfter?.instance_id).toBe(writerBefore?.instance_id);
            expect(writerAfter?.image_ref?.digest).toBe(
              writerBefore?.image_ref?.digest,
            );
            for (const id of next.consumer.machineIds) {
              const machine = live.find((machine) => machine.id === id);
              expect(machine?.config?.metadata?.["alchemy.phase"]).toBe(
                "active",
              );
              expect(machine?.image_ref?.digest).toBe(
                initial.consumer.imageRef?.digest,
              );
              const observed = yield* marker(initial.app.appName, id);
              expect(observed.code).toBe(0);
              expect(
                id === held.machineId ? ["two", "three"] : ["three"],
              ).toContain(observed.marker);
            }
            expect(
              yield* probeWriter(initial.app.appName, trigger, "GET"),
            ).toEqual(before);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.release();
              }),
            ),
            Effect.scoped,
          );
        }).pipe(Effect.scoped),
      { timeout: 900_000 },
    );
  },
);

describe.sequential(
  "scaling",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    test.provider(
      "S01 F13 real 1-to-10-to-10-to-1 generations pin one digest and check every candidate before routing or old retirement",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const proxy = yield* transportProxy();
          const actor = yield* engineActor(
            stack,
            "S01 F13 real 1-to-10-to-10-to-1 generations pin one digest and check every candidate before routing or old retirement",
            "test/Fly/BlueGreen.test.ts",
            proxy.url,
          );
          const services = [
            {
              protocol: "tcp" as const,
              internalPort: 80,
              autostop: "off" as const,
              ports: [{ port: 80, handlers: ["http" as const] }],
              checks: [
                {
                  type: "http" as const,
                  port: 80,
                  path: "/",
                  interval: "2s",
                  timeout: "1s",
                },
              ],
            },
          ];
          const deploy = (version: string, count: number) =>
            actor.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                return yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  count,
                  services,
                  checks,
                  env: { VERSION: version },
                  init: {
                    exec: [
                      "/bin/sh",
                      "-c",
                      "printf '%s:%s' \"$VERSION\" \"$FLY_MACHINE_ID\" > /usr/share/nginx/html/version; exec nginx -g 'daemon off;'",
                    ],
                  },
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "60 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                });
              }),
            );
          const client = yield* HttpClient.HttpClient;
          const traffic = (appName: string) =>
            client.get(`http://${appName}.fly.dev/version`).pipe(
              Effect.flatMap((response) => {
                expect(response.status).toBe(200);
                return response.text;
              }),
            );
          let previous = yield* deploy("one", 1);
          expect(
            yield* traffic(previous.appName).pipe(
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 8,
              }),
            ),
          ).toBe(`one:${previous.machineId}`);
          for (const [version, count] of [
            ["two", 10],
            ["three", 10],
            ["four", 1],
          ] as const) {
            const start = proxy.events.length;
            const next = yield* deploy(version, count);
            const events = proxy.events.slice(start);
            const live = yield* assertCommitted(next.appName, next.machineIds);
            expect(live).toHaveLength(count);
            expect(
              new Set(
                live.map(
                  (machine) => machine.config?.metadata?.["alchemy.generation"],
                ),
              ).size,
            ).toBe(1);
            expect(
              new Set(
                live.map(
                  (machine) => machine.config?.metadata?.["alchemy.replica"],
                ),
              ).size,
            ).toBe(count);
            expect(
              live.every(
                (machine) =>
                  machine.config?.metadata?.["alchemy.count"] ===
                    String(count) && machine.config?.env?.VERSION === version,
              ),
            ).toBe(true);
            expect(
              next.machineIds.every((id) => !previous.machineIds.includes(id)),
            ).toBe(true);
            const creates = events.filter(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith("/machines") &&
                event.status! < 300,
            );
            expect(creates).toHaveLength(count);
            const digest = creates[0]!.digest;
            expect(digest).toMatch(/^sha256:/);
            expect(
              live.every((machine) => machine.image_ref?.digest === digest),
            ).toBe(true);
            expect(
              creates
                .slice(1)
                .every((event) => event.image?.endsWith(`@${digest}`)),
            ).toBe(true);
            const firstRouting = events.findIndex(
              (event) =>
                event.stage === "request" && event.path.endsWith("/uncordon"),
            );
            expect(firstRouting).toBeGreaterThan(0);
            const beforeRouting = events.slice(0, firstRouting);
            for (const id of next.machineIds) {
              const reads = beforeRouting.filter(
                (event) =>
                  event.stage === "completed" &&
                  event.method === "GET" &&
                  event.path.endsWith(`/machines/${id}`) &&
                  event.status === 200,
              );
              const ready = reads.at(-1);
              const lastConfigWrite = beforeRouting.findLastIndex(
                (event) =>
                  event.stage === "completed" &&
                  event.machineId === id &&
                  event.status! < 300 &&
                  event.method !== "GET" &&
                  !event.path.endsWith("/lease"),
              );
              expect(ready).toBeDefined();
              expect(beforeRouting.indexOf(ready!)).toBeGreaterThan(
                lastConfigWrite,
              );
              expect(ready?.state).toBe("started");
              expect(ready?.cordoned).toBe(true);
              expect(ready?.instanceId).toBeDefined();
              expect(ready?.digest).toBe(digest);
              expect(
                ready?.checks?.find((check) => check.name === "ready")?.status,
              ).toBe("passing");
              expect(
                ready?.checks?.some((check) =>
                  check.name?.startsWith("servicecheck-"),
                ),
              ).toBe(true);
              expect(
                ready?.checks?.every((check) => check.status === "passing"),
              ).toBe(true);
            }
            expect(
              beforeRouting.some(
                (event) =>
                  event.stage === "request" &&
                  previous.machineIds.includes(event.machineId ?? "") &&
                  (event.path.endsWith("/stop") ||
                    event.path.endsWith("/cordon") ||
                    event.method === "DELETE") &&
                  !event.path.endsWith("/lease"),
              ),
            ).toBe(false);
            const served = yield* traffic(next.appName);
            expect(next.machineIds.map((id) => `${version}:${id}`)).toContain(
              served,
            );
            previous = next;
          }
          yield* stack.destroy();
          yield* assertAppGone(previous.appName);
        }).pipe(Effect.scoped),
      { tags: ["provider:fly:ipassignment"], timeout: 900_000 },
    );

    for (const [before, after] of [
      [1, 2],
      [2, 1],
    ] as const) {
      test.provider(
        `F13 ${before === 2 ? "F14 " : ""}replaces the complete replica set when scaling from ${before} to ${after}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const deploy = (count: number, strategy: "rolling" | "bluegreen") =>
              stack.deploy(
                Effect.gen(function* () {
                  const app = yield* Fly.App("Site");
                  return yield* Fly.Machine("Worker", {
                    app,
                    name: "scaling-worker",
                    image: "nginx:alpine",
                    count,
                    deploy: { strategy, healthTimeout: "30 seconds" },
                    shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                    checks: {
                      ready: {
                        type: "http",
                        port: 80,
                        path: "/",
                        interval: "2s",
                        timeout: "1s",
                      },
                    },
                  });
                }),
              );
            const initial = yield* deploy(
              before,
              before === 2 ? "rolling" : "bluegreen",
            );
            if (before === 2) {
              // Reproduce the ownership metadata written before generation support.
              for (const machineId of initial.machineIds) {
                for (const key of [
                  "alchemy.instance",
                  "alchemy.fqn",
                  "alchemy.base-name",
                ]) {
                  yield* machines.deleteMachineMetadata({
                    app_name: initial.appName,
                    machine_id: machineId,
                    key,
                  });
                }
              }
              const legacy = yield* machines
                .listMachines({ app_name: initial.appName })
                .pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    until: (listed) =>
                      listed.every(
                        (machine) =>
                          machine.config?.metadata?.["alchemy.instance"] ===
                          undefined,
                      ),
                    times: 8,
                  }),
                );
              expect(
                legacy.every(
                  (machine) =>
                    machine.config?.metadata?.["alchemy.instance"] ===
                    undefined,
                ),
              ).toBe(true);
            }
            const scaled = yield* deploy(after, "bluegreen");
            expect(scaled.count).toBe(after);
            expect(scaled.machineIds).toHaveLength(after);
            expect(
              scaled.machineIds.every((id) => !initial.machineIds.includes(id)),
            ).toBe(true);
            const live = (yield* machines.listMachines({
              app_name: initial.appName,
            })).filter((machine) => machine.state !== "destroyed");
            expect(live).toHaveLength(after);
            expect(
              live.every(
                (machine) =>
                  machine.cordoned === false &&
                  machine.config?.metadata?.["alchemy.phase"] === "active",
              ),
            ).toBe(true);
            expect(
              new Set(live.map((machine) => machine.image_ref?.digest)).size,
            ).toBe(1);
            yield* stack.destroy();
            yield* assertAppGone(initial.appName);
          }),
        { timeout: 300_000 },
      );
    }
  },
);

describe.sequential(
  "secrets",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    const marker = (appName: string, machineId: string) =>
      machines
        .execMachine({
          app_name: appName,
          machine_id: machineId,
          command: ["cat", "/usr/share/nginx/html/marker"],
          timeout: 5,
        })
        .pipe(
          Effect.map((response) => ({
            code: response.exit_code,
            marker: response.stdout?.trim(),
          })),
        );
    const init = {
      exec: [
        "/bin/sh",
        "-c",
        "case \"$ACCEPTANCE_SECRET\" in *-one) marker=one;; *-two) marker=two;; *-three) marker=three;; *) marker=missing;; esac; printf '%s' \"$marker\" > /usr/share/nginx/html/marker; exec nginx -g 'daemon off;'",
      ],
    };

    test.provider(
      "F12 staged standalone rotation requires an explicit floor and later vault versions satisfy that floor",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const firstSecret = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-one" },
          });
          const firstFloor = firstSecret.version ?? firstSecret.Version;
          expect(firstFloor).toBeGreaterThan(0);
          const first = yield* deployWorker(stack, "same-image", {
            init,
            minSecretsVersion: firstFloor,
          });
          expect(yield* marker(app.appName, first.machineId)).toEqual({
            code: 0,
            marker: "one",
          });
          const rotated = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-two" },
          });
          const floor = rotated.version ?? rotated.Version;
          expect(floor).toBeGreaterThan(firstFloor!);
          const unchanged = yield* deployWorker(stack, "same-image", {
            init,
            minSecretsVersion: firstFloor,
          });
          expect(unchanged.machineIds).toEqual(first.machineIds);
          expect(yield* marker(app.appName, first.machineId)).toEqual({
            code: 0,
            marker: "one",
          });
          // A later writer advances the shared vault; the requested version is a floor, not a snapshot.
          const later = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-three" },
          });
          expect(later.version ?? later.Version).toBeGreaterThan(floor!);
          const next = yield* deployWorker(stack, "same-image", {
            init,
            minSecretsVersion: floor,
          });
          expect(next.machineId).not.toBe(first.machineId);
          expect(yield* marker(app.appName, next.machineId)).toEqual({
            code: 0,
            marker: "three",
          });
          yield* assertCommitted(app.appName, next.machineIds);
          yield* stack.destroy();
          yield* assertAppGone(app.appName);
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "F12 bound Config and real Redis attachment rotate before every replacement candidate",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const proxy = yield* transportProxy();
          const actor = yield* engineActor(
            stack,
            "F12 bound Config and real Redis attachment rotate before every replacement candidate",
            "test/Fly/BlueGreen.test.ts",
            proxy.url,
          );
          const ambient = yield* ConfigProvider.ConfigProvider;
          const deploy = (version: "one" | "two", cache: "one" | "two") =>
            actor
              .deploy(
                Effect.gen(function* () {
                  const app = yield* SiteBluegreenSecrets;
                  const one = yield* CacheOne;
                  const two = yield* CacheTwo;
                  yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
                  const service = yield* BoundSecrets;
                  return { app, one, two, service };
                }),
              )
              .pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.orElse(
                    ConfigProvider.fromUnknown({
                      ACCEPTANCE_BOUND_SECRET: `fixture-token-${version}`,
                      ACCEPTANCE_CACHE: cache,
                    }),
                    ambient,
                  ),
                ),
              );
          const client = yield* HttpClient.HttpClient;
          const request = (appName: string, path: string) =>
            client.get(`http://${appName}.fly.dev${path}`).pipe(
              Effect.flatMap((response) => {
                expect(response.status).toBe(200);
                return response.json;
              }),
            );
          const initial = yield* deploy("one", "one");
          expect(
            yield* request(initial.app.appName, "/seed").pipe(
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 8,
              }),
            ),
          ).toEqual({ config: "one", redis: "one" });
          const configOnly = yield* deploy("two", "one");
          expect(
            configOnly.service.machineIds.every(
              (id) => !initial.service.machineIds.includes(id),
            ),
          ).toBe(true);
          expect(yield* request(initial.app.appName, "/marker")).toEqual({
            config: "two",
            redis: "one",
          });
          const start = proxy.events.length;
          const next = yield* deploy("two", "two");
          expect(next.one.redisId).toBe(initial.one.redisId);
          expect(next.two.redisId).toBe(initial.two.redisId);
          expect(
            next.service.machineIds.every(
              (id) => !configOnly.service.machineIds.includes(id),
            ),
          ).toBe(true);
          expect(yield* request(next.app.appName, "/marker")).toEqual({
            config: "two",
            redis: "empty",
          });
          expect(yield* request(next.app.appName, "/seed")).toEqual({
            config: "two",
            redis: "two",
          });
          const events = proxy.events.slice(start);
          const secretWrites = events.filter(
            (event) =>
              event.stage === "completed" &&
              event.method !== "GET" &&
              event.path.endsWith("/secrets") &&
              event.secretsVersion !== undefined,
          );
          expect(secretWrites.length).toBeGreaterThan(0);
          const floor = Math.max(
            ...secretWrites.map((event) => event.secretsVersion!),
          );
          const creates = events.filter(
            (event) =>
              event.stage === "request" &&
              event.method === "POST" &&
              event.path.endsWith("/machines"),
          );
          expect(creates).toHaveLength(2);
          expect(
            creates.every(
              (event) =>
                secretWrites.every(
                  (write) => events.indexOf(write) < events.indexOf(event),
                ) &&
                event.minSecretsVersion !== undefined &&
                event.minSecretsVersion >= floor,
            ),
          ).toBe(true);
          const live = yield* assertCommitted(
            next.app.appName,
            next.service.machineIds,
          );
          expect(
            live.every(
              (machine) =>
                machine.image_ref?.digest === initial.service.imageRef?.digest,
            ),
          ).toBe(true);
          yield* stack.destroy();
          yield* assertAppGone(next.app.appName);
          expect(
            yield* Fly.findRedisAddOn({
              id: next.one.redisId,
              name: next.one.name,
            }),
          ).toBeUndefined();
          expect(
            yield* Fly.findRedisAddOn({
              id: next.two.redisId,
              name: next.two.name,
            }),
          ).toBeUndefined();
        }).pipe(Effect.scoped),
      {
        tags: ["provider:fly:ipassignment", "provider:fly:redis"],
        timeout: 600_000,
      },
    );

    test.provider(
      "F12 Fly.Secret resource rotation is staged until an explicit Machine floor rollout",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (value: "one" | "two", floor?: number) =>
            stack.deploy(
              Effect.gen(function* () {
                const app = yield* Fly.App("Site");
                const secret = yield* Fly.Secret("Token", {
                  app,
                  name: "ACCEPTANCE_SECRET",
                  value: Redacted.make(`fixture-token-${value}`),
                });
                const worker = yield* Fly.Machine("Worker", {
                  app,
                  image: "nginx:alpine",
                  init,
                  checks,
                  minSecretsVersion: floor,
                  env: { SECRET_RESOURCE_NAME: secret.name },
                  deploy: {
                    strategy: "bluegreen",
                    healthTimeout: "30 seconds",
                  },
                  shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
                });
                return { app, secret, worker };
              }),
            );
          const initial = yield* deploy("one");
          expect(
            yield* marker(initial.app.appName, initial.worker.machineId),
          ).toEqual({ code: 0, marker: "one" });
          const staged = yield* deploy("two");
          expect(staged.secret.name).toBe(initial.secret.name);
          expect(staged.secret.digest).not.toBe(initial.secret.digest);
          expect(staged.worker.machineIds).toEqual(initial.worker.machineIds);
          expect(
            yield* marker(staged.app.appName, staged.worker.machineId),
          ).toEqual({ code: 0, marker: "one" });
          // A separate vault fence returns a floor that includes the completed Secret reconcile.
          const fence = yield* machines.updateSecrets({
            app_name: staged.app.appName,
            values: { ACCEPTANCE_FENCE: "two" },
          });
          const floor = fence.version ?? fence.Version;
          expect(floor).toBeGreaterThan(0);
          const next = yield* deploy("two", floor);
          expect(next.worker.machineId).not.toBe(initial.worker.machineId);
          expect(
            yield* marker(next.app.appName, next.worker.machineId),
          ).toEqual({
            code: 0,
            marker: "two",
          });
          const live = yield* assertCommitted(
            next.app.appName,
            next.worker.machineIds,
          );
          expect(live[0]?.image_ref?.digest).toBe(
            initial.worker.imageRef?.digest,
          );
          yield* stack.destroy();
          yield* assertAppGone(next.app.appName);
        }),
      { tags: ["provider:fly:secret"], timeout: 600_000 },
    );

    test.provider(
      "F12 a real concurrent vault writer advances the floor while the first candidate response is held",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const firstSecret = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-one" },
          });
          const initial = yield* deployWorker(stack, "same-image", {
            init,
            minSecretsVersion: firstSecret.version ?? firstSecret.Version,
          });
          const rotated = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-two" },
          });
          const floor = rotated.version ?? rotated.Version;
          expect(floor).toBeGreaterThan(0);
          const proxy = yield* transportProxy();
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) =>
                event.method === "POST" && event.path.endsWith("/machines"),
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const actor = yield* engineActor(
              stack,
              "F12 a real concurrent vault writer advances the floor while the first candidate response is held",
              "test/Fly/BlueGreen.test.ts",
              proxy.url,
            );
            const rollout = yield* deployWorker(actor, "same-image", {
              count: 2,
              init,
              minSecretsVersion: floor,
            }).pipe(Effect.scoped, Effect.forkScoped);
            const held = yield* proxy.wait(
              (event) => event.stage === "held" && event.status! < 300,
            );
            const writer = yield* machines
              .updateSecrets({
                app_name: app.appName,
                values: { ACCEPTANCE_SECRET: "fixture-token-three" },
              })
              .pipe(Effect.forkScoped);
            const later = yield* Fiber.join(writer);
            expect(later.version ?? later.Version).toBeGreaterThan(floor!);
            yield* Effect.sync(proxy.release);
            const next = yield* Fiber.join(rollout).pipe(
              Effect.timeout("180 seconds"),
            );
            const live = yield* assertCommitted(app.appName, next.machineIds);
            expect(next.machineIds).toContain(held.machineId);
            expect(next.machineIds).not.toContain(initial.machineId);
            const creates = proxy.events.filter(
              (event) =>
                event.stage === "request" &&
                event.method === "POST" &&
                event.path.endsWith("/machines"),
            );
            expect(creates).toHaveLength(2);
            expect(
              creates.every((event) => event.minSecretsVersion === floor),
            ).toBe(true);
            for (const machine of live) {
              const observed = yield* marker(app.appName, machine.id!);
              expect(observed.code).toBe(0);
              expect(
                machine.id === held.machineId ? ["two", "three"] : ["three"],
              ).toContain(observed.marker);
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.release();
              }),
            ),
            Effect.scoped,
          );
          yield* stack.destroy();
          yield* assertAppGone(app.appName);
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    );

    test.provider(
      "F12 interrupted promoted candidate cannot satisfy a newer explicit secret floor",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const firstSecret = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-one" },
          });
          yield* deployWorker(stack, "one", {
            init,
            minSecretsVersion: firstSecret.version ?? firstSecret.Version,
          });
          const rotated = yield* machines.updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-two" },
          });
          const floor = rotated.version ?? rotated.Version;
          const proxy = yield* transportProxy();
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) => event.path.endsWith("/uncordon"),
              action: "hold-response",
              remaining: 1,
            }),
          );
          yield* Effect.gen(function* () {
            const actor = yield* engineActor(
              stack,
              "F12 interrupted promoted candidate cannot satisfy a newer explicit secret floor",
              "test/Fly/BlueGreen.test.ts",
              proxy.url,
            );
            const rollout = yield* deployWorker(actor, "two", {
              init,
              minSecretsVersion: floor,
            }).pipe(Effect.scoped, Effect.forkScoped);
            const held = yield* proxy.wait(
              (event) => event.stage === "held" && event.status! < 300,
            );
            const interruption = yield* Fiber.interrupt(rollout).pipe(
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;
            yield* Effect.sync(() => {
              proxy.clear();
              proxy.release();
            });
            yield* Fiber.join(interruption).pipe(Effect.timeout("120 seconds"));
            expect(Exit.hasInterrupts(yield* Fiber.await(rollout))).toBe(true);
            expect(
              (yield* census(app.appName)).some(
                (machine) => machine.id === held.machineId,
              ),
            ).toBe(true);
            const later = yield* machines.updateSecrets({
              app_name: app.appName,
              values: { ACCEPTANCE_SECRET: "fixture-token-three" },
            });
            const nextFloor = later.version ?? later.Version;
            expect(nextFloor).toBeGreaterThan(floor!);
            const resumed = yield* engineActor(
              stack,
              "F12 interrupted promoted candidate cannot satisfy a newer explicit secret floor",
              "test/Fly/BlueGreen.test.ts",
            );
            const next = yield* deployWorker(resumed, "two", {
              init,
              minSecretsVersion: nextFloor,
            });
            expect(next.machineIds).not.toContain(held.machineId);
            expect(yield* marker(app.appName, next.machineId)).toEqual({
              code: 0,
              marker: "three",
            });
            yield* assertCommitted(app.appName, next.machineIds);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.release();
              }),
            ),
            Effect.scoped,
          );
          yield* stack.destroy();
          yield* assertAppGone(app.appName);
        }).pipe(Effect.scoped),
      { timeout: 600_000 },
    );
  },
);

describe.sequential(
  "managed HTTP services",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:redis",
      "provider:fly:secret",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    describe.sequential("Fly live HTTP and worker drain", () => {
      for (const policy of [
        {
          name: "managed old60/new10 SIGTERM",
          raw: false,
          old: "60 seconds",
          next: "10 seconds",
          signal: "SIGTERM",
          nextSignal: "SIGINT",
          rawSignal: undefined,
          nextRawSignal: undefined,
          delay: 12_000,
        },
        {
          name: "managed old10/new60 SIGINT",
          raw: false,
          old: "10 seconds",
          next: "60 seconds",
          signal: "SIGINT",
          nextSignal: "SIGTERM",
          rawSignal: undefined,
          nextRawSignal: undefined,
          delay: 3_000,
        },
        {
          name: "raw old60/new10 SIGQUIT to SIGTERM",
          raw: true,
          old: "60 seconds",
          next: "10 seconds",
          signal: "SIGTERM",
          nextSignal: "SIGTERM",
          rawSignal: "SIGQUIT",
          nextRawSignal: "SIGTERM",
          delay: 12_000,
        },
        {
          name: "raw old10/new60 SIGTERM to SIGQUIT",
          raw: true,
          old: "10 seconds",
          next: "60 seconds",
          signal: "SIGTERM",
          nextSignal: "SIGTERM",
          rawSignal: "SIGTERM",
          nextRawSignal: "SIGQUIT",
          delay: 3_000,
        },
      ] as const) {
        test.provider(
          `R01/R02/R03/R04 ${policy.name} preserves traffic, jobs and streaming after the actual stop barrier`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const scenario = yield* makeScenario(stack);
              yield* Effect.gen(function* () {
                const first = yield* scenario.deploy({
                  raw: policy.raw,
                  version: "one",
                  timeout: policy.old,
                  signal: policy.signal,
                  rawSignal: policy.rawSignal,
                  afterSignalMs: policy.delay,
                });
                const oldWorker = yield* requireValue(
                  first.worker,
                  "initial worker output",
                );
                const oldId = oldWorker.machineId;
                const url = `https://${first.workerApp.appName}.fly.dev`;
                const get = (route: string) =>
                  HttpClient.get(`${url}${route}`, {
                    headers: { connection: "close" },
                  }).pipe(
                    Effect.flatMap((response) =>
                      response.status === 200
                        ? response.text
                        : Effect.fail(new Error(`HTTP ${response.status}`)),
                    ),
                    Effect.timeout(route === "/" ? "5 seconds" : "240 seconds"),
                  );
                expect(
                  JSON.parse(
                    yield* get("/").pipe(
                      Effect.retry({
                        times: 8,
                        schedule: Schedule.spaced("1 second"),
                      }),
                    ),
                  ),
                ).toEqual({ machine: oldId, version: "one" });
                const observed = yield* machines.getMachine({
                  app_name: first.workerApp.appName,
                  machine_id: oldId,
                });
                expect(observed.config?.stop_config?.signal).toBe(
                  policy.rawSignal ?? policy.signal,
                );
                expect(
                  policy.old === "60 seconds"
                    ? ["60000ms", "60s", "1m", "1m0s"]
                    : ["10000ms", "10s"],
                ).toContain(observed.config?.stop_config?.timeout);
                yield* scenario.call(first.ledgerUrl, "enqueue", [
                  "in-flight-job",
                  "hold",
                ]);
                yield* scenario.wait(first.ledgerUrl, (ledger) =>
                  ledger.events.some(
                    (event) =>
                      event.machine === oldId &&
                      event.event === "claimed" &&
                      event.job === "in-flight-job",
                  ),
                );
                const slow = yield* get("/hold").pipe(Effect.forkScoped);
                const streamed = yield* get("/stream").pipe(Effect.forkScoped);
                yield* scenario.wait(
                  first.ledgerUrl,
                  (ledger) =>
                    ledger.events.filter(
                      (event) =>
                        event.machine === oldId &&
                        event.event === "request-started",
                    ).length === 2,
                );
                const responses = yield* Ref.make<
                  Array<
                    { machine: string; version: string } | { failure: string }
                  >
                >([]);
                const finished = yield* Ref.make(false);
                yield* Effect.addFinalizer(() =>
                  Ref.get(responses).pipe(
                    Effect.flatMap((samples) =>
                      Effect.logInfo(
                        "Unretried public traffic samples",
                        samples,
                      ),
                    ),
                  ),
                );
                const traffic = yield* Stream.range(0, 599).pipe(
                  Stream.mapEffect(() =>
                    get("/").pipe(
                      Effect.result,
                      Effect.flatMap((result) =>
                        Ref.update(responses, (values) => [
                          ...values,
                          Result.isSuccess(result)
                            ? (JSON.parse(result.success) as {
                                machine: string;
                                version: string;
                              })
                            : { failure: String(result.failure) },
                        ]),
                      ),
                      Effect.andThen(Effect.sleep("500 millis")),
                      Effect.andThen(Ref.get(finished)),
                    ),
                  ),
                  Stream.takeUntil((done) => done),
                  Stream.runDrain,
                  Effect.forkScoped,
                );
                const second = yield* scenario.deploy({
                  raw: policy.raw,
                  version: "two",
                  timeout: policy.next,
                  signal: policy.nextSignal,
                  rawSignal: policy.nextRawSignal,
                  afterSignalMs: 1000,
                });
                const newWorker = yield* requireValue(
                  second.worker,
                  "replacement worker output",
                );
                expect(JSON.parse(yield* Fiber.join(slow))).toEqual({
                  machine: oldId,
                  version: "one",
                });
                const body = yield* Fiber.join(streamed);
                const expected =
                  "first\n".repeat(32768) + "last\n".repeat(32768);
                const hashes = yield* Effect.sync(() =>
                  [body, expected].map((value) =>
                    createHash("sha256").update(value).digest("hex"),
                  ),
                );
                expect(body.length).toBe(360448);
                expect(hashes[0]).toBe(hashes[1]);
                expect(JSON.parse(yield* get("/"))).toEqual({
                  machine: newWorker.machineId,
                  version: "two",
                });
                yield* Effect.sleep("600 millis");
                yield* Ref.set(finished, true);
                yield* Fiber.join(traffic);
                const samples = yield* Ref.get(responses);
                expect(samples.filter((sample) => "failure" in sample)).toEqual(
                  [],
                );
                expect(
                  samples.some(
                    (sample) =>
                      "version" in sample &&
                      sample.version === "one" &&
                      sample.machine === oldId,
                  ),
                ).toBe(true);
                expect(
                  samples.some(
                    (sample) =>
                      "version" in sample &&
                      sample.version === "two" &&
                      sample.machine === newWorker.machineId,
                  ),
                ).toBe(true);
                yield* assertReplacement(
                  first.workerApp.appName,
                  oldId,
                  newWorker.machineId,
                );
                const ledger = yield* scenario.settle(first.ledgerUrl);
                assertStopped(ledger.events, oldId);
                assertOrder(
                  ledger.events,
                  oldId,
                  "request-finalized",
                  "shared-closed",
                );
                assertOrder(
                  ledger.events,
                  oldId,
                  "client-released",
                  "shared-closed",
                );
                const stop = yield* requireValue(
                  ledger.events.find(
                    (event) =>
                      event.machine === oldId && event.event === "stop-started",
                  ),
                  "old worker stop event",
                );
                if (policy.raw) expect(stop.signal).toBe(policy.rawSignal);
                const completed = ledger.events.filter(
                  (event) =>
                    event.machine === oldId &&
                    event.event === "response-finished",
                );
                expect(completed).toHaveLength(2);
                for (const event of completed) {
                  expect(event.at - stop.at).toBeGreaterThan(
                    policy.delay - 500,
                  );
                }
                const ack = yield* requireValue(
                  ledger.events.find(
                    (event) =>
                      event.machine === oldId &&
                      event.event === "acked" &&
                      event.job === "in-flight-job",
                  ),
                  "in-flight job ACK event",
                );
                expect(ack.ack).toBe(1);
                expect(ack.at - stop.at).toBeGreaterThan(policy.delay - 500);
                if (policy.old === "10 seconds")
                  expect(ack.at - stop.at).toBeLessThan(10_000);
              }).pipe(Effect.scoped, Effect.ensuring(scenario.cleanup));
            }),
          {
            // Includes cold publication, both readiness phases, proxy overlap, post-signal work and census.
            timeout: 480_000,
          },
        );
      }
    });
  },
);

describe.sequential(
  "shutdown policy",
  { tags: ["provider:fly", "provider:fly:service"] },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    it.effect(
      "R02 predecessor policy preserves raw overrides and managed legacy grace",
      () =>
        Effect.gen(function* () {
          for (const timeout of ["10s", "60s"]) {
            for (const signal of ["SIGQUIT", "SIGTERM"] as const) {
              const policy = yield* predecessorShutdown({
                config: { stop_config: { signal, timeout } },
              });
              expect(policy.signal).toBe(signal);
              expect(policy.timeout).toBe(timeout);
            }
          }
          const raw = yield* predecessorShutdown({ config: {} });
          expect(raw.signal).toBeUndefined();
          expect(raw.timeout).toBeUndefined();
          const legacy = yield* predecessorShutdown({
            config: {
              stop_config: { signal: "SIGINT" },
              env: { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "60000" },
            },
          });
          expect(legacy).toEqual({
            signal: "SIGINT",
            timeout: "60000ms",
            timeoutMs: 60000,
          });
          for (const injected of ["broken", "0", "300001", "60000"]) {
            const error = yield* predecessorShutdown({
              config: {
                stop_config: { signal: "SIGTERM", timeout: "10s" },
                env: { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: injected },
              },
            }).pipe(Effect.flip);
            expect(error._tag).toBe("Fly.ShutdownPolicyMismatch");
          }
        }),
      { tags: ["unit", "local"] },
    );

    test.provider(
      "R02 observed predecessor policy survives replacement and retires suspended without resume",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const current = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("Site");
              return yield* Fly.Machine("Worker", {
                app,
                image: "nginx:alpine",
                shutdown: { signal: "SIGQUIT", timeout: "60 seconds" },
              });
            }),
          );
          const request = {
            app_name: current.appName,
            machine_id: current.machineId,
          };
          const observed = yield* machines.getMachine(request);
          expect((yield* predecessorShutdown(observed)).timeoutMs).toBe(60_000);
          yield* machines.suspendMachine(request);
          yield* machines.waitMachine({
            ...request,
            state: "suspended",
            timeout: 8,
          });
          yield* retireMachine(current.appName, current.machineId);
          expect(
            yield* machines.getMachine(request).pipe(
              Effect.map((machine) => machine.state === "destroyed"),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
          yield* stack.destroy();
        }),
      {
        tags: ["provider:fly:app", "provider:fly:machine", "live"],
        timeout: 120_000,
      },
    );
  },
);

describe.sequential(
  "process signals and overlap",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const options = {
      providers: Fly.providers(),
      profile: "testing",
      dev: false,
      sidecar: false,
    };
    const { test, beforeEach, afterEach } = Test.make(options);
    const selected = process.env.FLY_SIGNAL_OVERLAP_CASE;
    let signaled:
      | {
          witness: WitnessSignalOverlap;
          paths: Effect.Success<ReturnType<typeof pathsFor>>;
        }
      | undefined;

    // Observe the runner's own teardown; never bridge SIGINT into a manual fiber interrupt.
    afterEach(
      Effect.gen(function* () {
        if (!signaled || signaled.witness.signal !== "SIGINT") return;
        const { witness, paths } = signaled;
        const fs = yield* FileSystem.FileSystem;
        yield* writeEvidence(paths.runnerInterrupted, {
          pid: yield* Effect.sync(() => process.pid),
          case: witness.case,
          signal: "SIGINT",
          witnessRecordedAt: witness.recordedAt,
          at: yield* nowSeconds,
          deployFinalized: yield* fs.exists(paths.finalized),
        } satisfies typeof RunnerInterrupted.Type);
      }),
      { timeout: 30_000 },
    );

    const crash = (
      stack: Test.ScratchStack,
      title: string,
      selectedCase: SignalCase,
    ) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* pathsFor(stack);
        // Never erase an incomplete signal attempt to make a retry green.
        if (
          (yield* fs.exists(paths.witness)) &&
          !(yield* fs.exists(paths.recovered))
        ) {
          return yield* Effect.fail(
            new Error(
              "An unrecovered signal witness exists; preserve it and use the recovery leg",
            ),
          );
        }
        for (const file of [
          paths.witness,
          paths.finalized,
          paths.runnerInterrupted,
          paths.blocked,
          paths.recovered,
        ]) {
          yield* fs.remove(file, { force: true });
        }
        yield* stack.destroy();
        const initial = yield* deploy(stack, "one").pipe(Effect.scoped);
        expect(initial.machineIds).toHaveLength(1);
        const predecessor = yield* identity(
          yield* machine(initial.appName, initial.machineId),
          stack,
        );
        expect(predecessor.phase).toBe("active");
        const proxy = yield* transportProxy();
        const actor = yield* Effect.sync(() =>
          scratchStack(
            {
              ...options,
              providers: throughProxy(() => proxy.url),
              stage: stack.stage,
            },
            title,
            signalOverlapFile,
          ),
        );
        expect(actor.name).toBe(stack.name);
        expect(actor.stage).toBe(stack.stage);
        expect(actor.state).not.toBe(stack.state);
        const match = (event: Parameters<typeof matches>[4]) =>
          matches(
            selectedCase.phase,
            initial.appName,
            predecessor.id,
            proxy.events,
            event,
          );
        yield* Effect.sync(() =>
          proxy.arm({ match, action: "hold-response", remaining: 1 }),
        );
        const pid = yield* Effect.sync(() => process.pid);
        let armed: WitnessSignalOverlap | undefined;
        const attempt = yield* deploy(actor, "two").pipe(
          Effect.scoped,
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (!armed) {
                yield* writeEvidence(paths.finalized, {
                  pid,
                  case: selectedCase.name,
                  armed: false,
                });
                return;
              }
              // The deploy scope has closed, including native lease-release finalizers.
              const leases = yield* observeLeases(armed);
              const releases = yield* Effect.sync(() =>
                proxy.events
                  .filter(
                    (event) =>
                      event.stage === "completed" &&
                      event.sequence > armed!.barrier.sequence &&
                      event.method === "DELETE" &&
                      event.path.endsWith("/lease") &&
                      successful(event),
                  )
                  .map(boundary),
              );
              yield* writeEvidence(paths.finalized, {
                pid,
                case: selectedCase.name,
                witnessRecordedAt: armed.recordedAt,
                interruptedOnly:
                  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
                at: yield* nowSeconds,
                releases,
                leases,
              } satisfies typeof Finalized.Type);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.gen(function* () {
          const barrier = yield* proxy.wait(
            (event) =>
              event.stage === "held" && successful(event) && match(event),
          );
          yield* Effect.gen(function* () {
            const live = yield* censusProcessDeath(initial.appName);
            const candidates = live.filter(
              (value) => value.id !== predecessor.id,
            );
            expect(candidates).toHaveLength(1);
            const candidate = yield* identity(
              yield* machine(initial.appName, candidates[0]!.id!),
              stack,
            );
            expect(candidate.generation).not.toBe(predecessor.generation);
            expect(candidate.workload).not.toBe(predecessor.workload);
            expect(Number(candidate.sequence)).toBe(
              Number(predecessor.sequence) + 1,
            );
            expect(candidate.instance).toBe(predecessor.instance);
            expect(candidate.fqn).toBe(predecessor.fqn);
            const leases = yield* heldLeases(
              initial.appName,
              live.map((value) => value.id!),
            );
            expect(leases.map((value) => value.machineId).sort()).toEqual(
              (selectedCase.phase === "create"
                ? [predecessor.id]
                : selectedCase.phase === "retirement"
                  ? [candidate.id]
                  : [predecessor.id, candidate.id]
              ).sort(),
            );
            for (const held of leases) {
              expect(
                proxy.events.some(
                  (event) =>
                    event.stage === "completed" &&
                    event.method === "POST" &&
                    event.path.endsWith(`/machines/${held.machineId}/lease`) &&
                    successful(event),
                ),
              ).toBe(true);
            }
            const row = yield* persistedRow(stack, candidate.fqn);
            expect(row.instanceId).toBe(candidate.instance);
            expect(row.status).toBe("updating");
            const returned = firstReturnedUncordon(
              proxy.events,
              initial.appName,
            );
            const witness = {
              version: 1,
              case: selectedCase.name,
              signal: selectedCase.signal,
              phase: selectedCase.phase,
              pid,
              cwd: paths.cwd,
              stack: stack.name,
              stage: stack.stage,
              appName: initial.appName,
              recordedAt: yield* nowSeconds,
              predecessor,
              candidate,
              barrier: boundary(barrier),
              ...(selectedCase.phase === "overlap"
                ? { returnedUncordon: boundary(returned!) }
                : {}),
              leases,
              row,
            } satisfies WitnessSignalOverlap;
            yield* assertBoundary(witness);
            yield* assertInventory(stack, witness);
            yield* writeEvidence(paths.witness, witness);
            expect(
              yield* readEvidence(paths.witness, WitnessSignalOverlap),
            ).toEqual(witness);
            yield* Effect.sync(() => {
              expect(attempt.pollUnsafe() === undefined).toBe(true);
              expect(
                proxy.events.some(
                  (event) =>
                    event.sequence === barrier.sequence &&
                    ["forwarded", "dropped"].includes(event.stage),
                ),
              ).toBe(false);
              expect(
                proxy.events.some(
                  (event) =>
                    event.method === "DELETE" && event.path.endsWith("/lease"),
                ),
              ).toBe(false);
              expect(
                proxy.events.some(
                  (event) =>
                    event.stage === "request" &&
                    event.sequence > barrier.sequence &&
                    event.method !== "GET" &&
                    !event.path.endsWith("/lease"),
                ),
              ).toBe(false);
              if (selectedCase.phase === "overlap") {
                expect(returned).toBeDefined();
                expect(
                  proxy.events.filter(
                    (event) =>
                      event.stage === "forwarded" &&
                      event.path.endsWith("/uncordon"),
                  ),
                ).toHaveLength(1);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.sequence === returned!.sequence &&
                      ["held", "dropped"].includes(event.stage),
                  ),
                ).toBe(false);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "request" &&
                      event.path.endsWith("/cordon"),
                  ),
                ).toBe(false);
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "request" &&
                      event.sequence === barrier.sequence &&
                      event.method === "GET" &&
                      event.machineId === candidate.id,
                  ),
                ).toBe(true);
              }
              if (selectedCase.signal === "SIGINT") {
                expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
              }
              expect(process.pid).toBe(witness.pid);
              armed = witness;
              signaled = { witness, paths };
              process.kill(process.pid, selectedCase.signal);
            });
            if (selectedCase.signal === "SIGKILL") {
              return yield* Effect.fail(
                new Error("SIGKILL did not terminate the sole runner"),
              );
            }
          }).pipe(Effect.timeout("20 seconds"));
          // Only the runner may interrupt the deploy; the held response stays held.
          return yield* Effect.never;
        }).pipe(
          Effect.raceFirst(
            Fiber.join(attempt).pipe(
              Effect.andThen(
                Effect.fail(
                  new Error(
                    "Rollout completed instead of terminating at the signal barrier",
                  ),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped);

    const recover = (stack: Test.ScratchStack, selectedCase: SignalCase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* pathsFor(stack);
        const witness = yield* readEvidence(
          paths.witness,
          WitnessSignalOverlap,
        );
        const pid = yield* Effect.sync(() => process.pid);
        expect(witness.pid).toBeGreaterThan(0);
        expect(pid).not.toBe(witness.pid);
        expect(witness.case).toBe(selectedCase.name);
        expect(witness.signal).toBe(selectedCase.signal);
        expect(witness.phase).toBe(selectedCase.phase);
        expect(witness.cwd).toBe(paths.cwd);
        expect(witness.stack).toBe(stack.name);
        expect(witness.stage).toBe(stack.stage);
        expect(yield* fs.exists(paths.recovered)).toBe(false);
        yield* assertBoundary(witness);
        expect(yield* persistedRow(stack, witness.row.fqn)).toEqual(
          witness.row,
        );
        expect(witness.row.status).toBe("updating");
        yield* assertInventory(stack, witness);
        // No deploy, destroy, acquire or release can manufacture either lease proof.
        const authority = yield* Effect.gen(function* () {
          if (selectedCase.signal === "SIGKILL") {
            expect(yield* fs.exists(paths.finalized)).toBe(false);
            expect(yield* fs.exists(paths.runnerInterrupted)).toBe(false);
            return { mode: "expiry", evidence: yield* observeExpiry(witness) };
          }
          const runner = yield* readEvidence(
            paths.runnerInterrupted,
            RunnerInterrupted,
          );
          expect(runner.pid).toBe(witness.pid);
          expect(runner.case).toBe(witness.case);
          expect(runner.witnessRecordedAt).toBe(witness.recordedAt);
          expect(runner.at).toBeGreaterThanOrEqual(witness.recordedAt);
          if (!(yield* fs.exists(paths.finalized))) {
            yield* writeEvidence(paths.blocked, {
              case: witness.case,
              crashPid: witness.pid,
              recoveryPid: pid,
              runner,
              leases: yield* observeLeases(witness),
              nativeFinalizerProved: false,
              recovered: false,
            });
            return yield* Effect.fail(
              new Error(
                "SIGINT reached runner teardown but the scoped deploy did not finalize; native lease RELEASE is unproved. Preserve this attempt; expiry is not SIGINT acceptance.",
              ),
            );
          }
          expect(runner.deployFinalized).toBe(true);
          const finalized = yield* readEvidence(paths.finalized, Finalized);
          return {
            mode: "release",
            runner,
            evidence: yield* assertReleased(witness, finalized),
          };
        });
        yield* assertInventory(stack, witness);
        const recovered = yield* deploy(stack, "two").pipe(Effect.scoped);
        expect(recovered.appName).toBe(witness.appName);
        yield* assertConvergedSignalOverlap(
          stack,
          witness,
          recovered.machineIds,
        );
        const unchanged = yield* deploy(stack, "two").pipe(Effect.scoped);
        expect(unchanged.machineIds).toEqual(recovered.machineIds);
        yield* assertConvergedSignalOverlap(
          stack,
          witness,
          unchanged.machineIds,
        );
        yield* stack.destroy();
        yield* assertClean(stack, witness.appName);
        yield* writeEvidence(paths.recovered, {
          case: witness.case,
          signal: witness.signal,
          phase: witness.phase,
          crashPid: witness.pid,
          recoveryPid: pid,
          barrier: witness.barrier,
          returnedUncordon: witness.returnedUncordon,
          authority,
          machineIds: recovered.machineIds,
          generation: witness.candidate.generation,
          digest: witness.candidate.digest,
          cleaned: true,
        });
      });

    // Runner bodies are detached; ordinary setup hooks remain attached to runMain.
    beforeEach(
      Effect.gen(function* () {
        if (process.env.FLY_SIGNAL_OVERLAP_MODE !== "crash") return;
        yield* assertSingleRunnerSignalOverlap;
        const selectedCase = cases.find((value) => value.name === selected);
        if (!selectedCase) {
          return yield* Effect.fail(new Error("Unknown signal case selector"));
        }

        const stack = yield* Effect.sync(() =>
          scratchStack(
            options,
            `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`,
            signalOverlapFile,
          ),
        );
        yield* withProviders(
          crash(
            stack,
            `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`,
            selectedCase,
          ),
          options,
          stack.name,
        );
      }).pipe(Effect.scoped),
      { timeout: 750_000 },
    );

    for (const selectedCase of cases) {
      const skip =
        selected === undefined ||
        (cases.some((value) => value.name === selected) &&
          selected !== selectedCase.name);
      if (skip) {
        it.live.skip(
          `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`,
          () => Effect.void,
        );
        continue;
      }
      // No destroy-on-failure wrapper: failed recovery must preserve the forensic state.
      test(
        `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`,
        Effect.gen(function* () {
          yield* assertSingleRunnerSignalOverlap;
          expect(selected).toBe(selectedCase.name);
          const mode = process.env.FLY_SIGNAL_OVERLAP_MODE;
          if (mode !== "crash" && mode !== "recovery") {
            return yield* Effect.fail(
              new Error("FLY_SIGNAL_OVERLAP_MODE must be crash or recovery"),
            );
          }
          if (mode === "crash") {
            return yield* Effect.fail(
              new Error(
                "The crash setup returned without terminating the runner",
              ),
            );
          }
          const stack = yield* Effect.sync(() =>
            scratchStack(
              options,
              `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`,
              signalOverlapFile,
            ),
          );
          yield* withProviders(
            recover(stack, selectedCase),
            options,
            stack.name,
          );
        }).pipe(Effect.scoped),
        { timeout: 750_000, retry: 0, exclusive: true },
      );
    }
  },
);

describe.sequential(
  "state persistence",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const stackName = "Fly-BlueGreenStatePersistence-delayed-durable-write";
    const options = {
      providers: Fly.providers(),
      dev: false,
      sidecar: false,
      stage: undefined,
    };
    const { test } = Test.make(options);

    const actor = (state = localState(), endpoint?: string) => {
      const providers = throughProxy(() => endpoint);
      const stack = (version: string) =>
        Alchemy.Stack(
          stackName,
          { providers, state },
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              env: { VERSION: version },
              checks,
              deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
          }),
        );
      return {
        state,
        // Private execution scopes avoid Test.make's file-shared destroy scope.
        deploy: (version: string) => TestCore.deploy(options, stack(version)),
        destroy: () => TestCore.destroy(options, stack("three")),
      };
    };

    test(
      "F11 delayed durable LocalState rename cannot authorize deletion of the live successor",
      TestCore.withProviders(
        Effect.gen(function* () {
          const target = {
            stack: stackName,
            stage: Test.resolveStage(options),
          };
          const readWorker = () =>
            Effect.gen(function* () {
              const state = yield* makeLocalState();
              return yield* state.get({ ...target, fqn: "Worker" }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(ResourceRow)),
                Effect.catchTag("SchemaError", () =>
                  Effect.fail(
                    new Error("Missing or invalid durable Worker row"),
                  ),
                ),
              );
            });
          const assertEmptyState = () =>
            Effect.gen(function* () {
              const state = yield* makeLocalState();
              expect(yield* state.list(target)).toEqual([]);
              expect(
                (yield* state.get({ ...target, fqn: "Worker" })) === undefined,
              ).toBe(true);
              expect(
                (yield* state.get({ ...target, fqn: "Site" })) === undefined,
              ).toBe(true);
              expect((yield* state.getOutput(target)) === undefined).toBe(true);
              expect(yield* state.listStages(target.stack)).not.toContain(
                target.stage,
              );
            });
          yield* actor().destroy();
          yield* assertEmptyState();
          let appName: string | undefined;
          const cleanup = Effect.gen(function* () {
            yield* actor().destroy();
            if (appName !== undefined) {
              yield* assertAppGone(appName);
              const remainingMachines = yield* machines
                .listMachines({ app_name: appName })
                .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
              const remainingVolumes = yield* machines
                .listVolumes({ app_name: appName })
                .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
              expect(
                remainingMachines
                  .filter((machine) => machine.state !== "destroyed")
                  .map((machine) => machine.id),
              ).toEqual([]);
              expect(remainingVolumes.map((volume) => volume.id)).toEqual([]);
            }
            yield* assertEmptyState();
          });
          yield* Effect.gen(function* () {
            const initial = yield* actor().deploy("one");
            yield* Effect.sync(() => {
              appName = initial.appName;
            });
            const initialRow = yield* readWorker();
            expect(initialRow.status).toBe("created");
            expect(initialRow.attr?.machineIds).toEqual(initial.machineIds);
            const gate = yield* delayedResourceWrite({
              ...target,
              fqn: "Worker",
            });
            const actorA = actor(gate.state);
            const actorB = actor();
            expect(actorA.state).not.toBe(actorB.state);
            yield* Effect.gen(function* () {
              const delayed = yield* actorA
                .deploy("two")
                .pipe(Effect.forkScoped);
              yield* Effect.gen(function* () {
                const held = yield* gate.wait.pipe(
                  Effect.raceFirst(
                    Fiber.join(delayed).pipe(
                      Effect.flatMap(() =>
                        Effect.fail(
                          new Error(
                            "Actor A finished without holding its final rename",
                          ),
                        ),
                      ),
                    ),
                  ),
                );
                expect(held.status).toBe("updated");
                expect(held.instanceId).toBe(initialRow.instanceId);
                expect(held.attr?.machineIds).toHaveLength(1);
                expect(held.attr?.machineId).not.toBe(initial.machineId);
                const heldIds = [...held.attr!.machineIds];
                const prepared = yield* assertCommitted(
                  initial.appName,
                  heldIds,
                );
                expect(prepared[0]?.config?.env?.VERSION).toBe("two");
                expect(
                  prepared[0]?.config?.metadata?.["alchemy.instance"],
                ).toBe(held.instanceId);
                expect(prepared[0]?.config?.metadata?.["alchemy.fqn"]).toBe(
                  "Worker",
                );
                const beforeRename = yield* readWorker();
                expect(beforeRename.status).toBe("updating");
                expect(beforeRename.attr?.machineIds).not.toEqual(heldIds);

                // B observes A's completed rollout while A's terminal row is still a temp file.
                const newer = yield* actorB.deploy("three");
                expect(newer.appName).toBe(initial.appName);
                expect(newer.machineIds).toHaveLength(1);
                expect(newer.machineId).not.toBe(held.attr?.machineId);
                const newerRow = yield* readWorker();
                expect(newerRow.status).toBe("updated");
                expect(newerRow.instanceId).toBe(held.instanceId);
                expect(newerRow.attr?.machineIds).toEqual(newer.machineIds);
                const successor = yield* assertCommitted(
                  newer.appName,
                  newer.machineIds,
                );
                const successorMetadata = successor[0]!.config!.metadata!;
                expect(successor[0]?.config?.env?.VERSION).toBe("three");
                expect(successorMetadata["alchemy.instance"]).toBe(
                  held.instanceId,
                );
                expect(successorMetadata["alchemy.fqn"]).toBe("Worker");
                expect(successorMetadata["alchemy.generation"]).not.toBe(
                  prepared[0]?.config?.metadata?.["alchemy.generation"],
                );
                expect(
                  Number(successorMetadata["alchemy.sequence"]),
                ).toBeGreaterThan(
                  Number(prepared[0]?.config?.metadata?.["alchemy.sequence"]),
                );

                yield* gate.release;
                const late = yield* Fiber.join(delayed).pipe(
                  Effect.timeout("600 seconds"),
                );
                expect(late.machineIds).toEqual(heldIds);
                expect((yield* gate.written).attr?.machineIds).toEqual(heldIds);
                const stale = yield* readWorker();
                // This controlled late rename wins on disk, not in the cloud; there is no fence.
                expect(stale.status).toBe("updated");
                expect(stale.instanceId).toBe(held.instanceId);
                expect(stale.attr?.machineIds).toEqual(heldIds);
                yield* assertCommitted(newer.appName, newer.machineIds);

                const proxy = yield* transportProxy();
                const actorC = actor(localState(), proxy.url);
                expect(actorC.state).not.toBe(actorA.state);
                expect(actorC.state).not.toBe(actorB.state);
                const recovered = yield* actorC.deploy("three");
                expect(
                  proxy.events.some(
                    (event) =>
                      event.stage === "completed" &&
                      event.method === "GET" &&
                      event.path === `/v1/apps/${newer.appName}/machines` &&
                      event.status === 200,
                  ),
                ).toBe(true);
                expect(
                  proxy.events.filter(
                    (event) =>
                      event.stage === "request" &&
                      newer.machineIds.includes(event.machineId ?? "") &&
                      (event.path.endsWith("/cordon") ||
                        event.path.endsWith("/stop") ||
                        (event.method === "DELETE" &&
                          !event.path.endsWith("/lease"))),
                  ),
                ).toEqual([]);
                const preserved = yield* assertCommitted(
                  newer.appName,
                  newer.machineIds,
                );
                expect(
                  preserved[0]?.config?.metadata?.["alchemy.instance"],
                ).toBe(successorMetadata["alchemy.instance"]);
                expect(
                  preserved[0]?.config?.metadata?.["alchemy.generation"],
                ).toBe(successorMetadata["alchemy.generation"]);
                const recoveredRow = yield* readWorker();
                expect(recoveredRow.instanceId).toBe(held.instanceId);
                expect(recovered.machineIds).toEqual(newer.machineIds);
                expect(recoveredRow.status).toBe("updated");
                expect(recoveredRow.attr?.machineIds).toEqual(newer.machineIds);
              }).pipe(
                Effect.ensuring(
                  gate.release.pipe(
                    Effect.andThen(
                      Fiber.await(delayed).pipe(
                        Effect.timeout("600 seconds"),
                        Effect.orDie,
                      ),
                    ),
                  ),
                ),
              );
            }).pipe(Effect.scoped);
          }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
        }).pipe(Effect.scoped),
        options,
        stackName,
      ),
      { timeout: 1_800_000, retry: 0 },
    );
  },
);

describe.sequential(
  "transport",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });

    test.provider(
      "F02 S07 harness forwards real Fly responses, loses completed responses and cuts connections",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const app = yield* stack.deploy(Fly.App("Site"));
          const proxy = yield* transportProxy();
          yield* Effect.sync(() => {
            endpoint = proxy.url;
          });
          try {
            const request = machines
              .getApp({ app_name: app.appName })
              .pipe(Retry.none);
            const forwarded = yield* request;
            expect(forwarded.name).toBe(app.appName);
            expect(
              proxy.events.some(
                (event) => event.stage === "forwarded" && event.status === 200,
              ),
            ).toBe(true);
            yield* Effect.sync(() =>
              proxy.arm({
                match: (event) => event.path.endsWith(`/apps/${app.appName}`),
                action: "drop-response",
                remaining: 1,
              }),
            );
            const dropped = yield* request.pipe(Effect.result);
            // The HTTP runtime may transparently replay an idempotent GET after a socket reset.
            if (Result.isFailure(dropped))
              expect(dropped.failure._tag).toBe("HttpClientError");
            else expect(dropped.success.name).toBe(app.appName);
            expect(
              proxy.events.filter(
                (event) => event.stage === "dropped" && event.status === 200,
              ),
            ).toHaveLength(1);
            yield* Effect.sync(() =>
              proxy.arm({
                match: () => true,
                action: "cut-request",
                remaining: Infinity,
              }),
            );
            const cut = yield* request.pipe(Effect.result);
            expect(Result.isFailure(cut)).toBe(true);
            const cutEvent = proxy.events.find(
              (event) => event.stage === "cut",
            )!;
            expect(
              proxy.events.some(
                (event) =>
                  event.sequence === cutEvent.sequence &&
                  event.stage === "completed",
              ),
            ).toBe(false);
            yield* Effect.sync(() => {
              proxy.clear();
              proxy.arm({
                match: () => true,
                action: "hold-response",
                remaining: 1,
              });
            });
            const child = yield* request.pipe(Effect.forkScoped);
            const held = yield* proxy.wait((event) => event.stage === "held");
            expect(held.status).toBe(200);
            yield* Effect.sync(proxy.release);
            expect(
              (yield* Fiber.join(child).pipe(Effect.timeout("10 seconds")))
                .name,
            ).toBe(app.appName);
            expect((yield* request).name).toBe(app.appName);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
              proxy.release();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(app.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "validation",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    let endpoint: string | undefined;
    const { test } = Test.make({ providers: throughProxy(() => endpoint) });
    const invalid: Array<
      [string, Partial<Extract<MachineProps, { image: string }>>]
    > = [
      ["direct volume", { mounts: [{ path: "/data", sizeGb: 1 }] }],
      ["skipLaunch", { skipLaunch: true }],
      ["autoDestroy", { autoDestroy: true }],
      ["restart=no", { restart: { policy: "no" } }],
      ["missing checks", { checks: {} }],
      [
        "unchecked public service",
        { services: [{ internalPort: 80, ports: [{ port: 80 }] }] },
      ],
    ];

    describe.sequential("pre-mutation validation", () => {
      for (const [label, props] of invalid) {
        test.provider(
          `${label === "direct volume" ? "S10" : "S11"} ${label} rejects before any Machine mutation`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const app = yield* stack.deploy(Fly.App("Site"));
              const proxy = yield* transportProxy();
              yield* Effect.sync(() => {
                endpoint = proxy.url;
              });
              const failed = yield* stack
                .deploy(
                  Effect.gen(function* () {
                    const app = yield* Fly.App("Site");
                    return yield* Fly.Machine("Worker", {
                      app,
                      image: "nginx:alpine",
                      checks,
                      deploy: { strategy: "bluegreen" },
                      ...props,
                    });
                  }),
                )
                .pipe(Effect.result);
              expect(Result.isFailure(failed)).toBe(true);
              if (Result.isFailure(failed))
                expect(failed.failure).toMatchObject({
                  _tag: "Fly.InvalidDeployment",
                });
              expect(
                proxy.events.some(
                  (event) =>
                    event.method !== "GET" &&
                    /\/(machines|volumes)(\/|$)/.test(event.path),
                ),
              ).toBe(false);
              expect(yield* census(app.appName)).toHaveLength(0);
              expect(
                yield* machines.listVolumes({ app_name: app.appName }),
              ).toHaveLength(0);
              yield* Effect.sync(() => {
                endpoint = undefined;
              });
              yield* stack.destroy();
              yield* assertAppGone(app.appName);
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  endpoint = undefined;
                }),
              ),
            ),
          { timeout: 180_000 },
        );
      }

      test.provider(
        "S10 resolved MountVolume binding rejects before Machine or Volume mutation",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const app = yield* stack.deploy(Fly.App("Site"));
            const proxy = yield* transportProxy();
            yield* Effect.sync(() => {
              endpoint = proxy.url;
            });
            const failed = yield* stack
              .deploy(MountedBlueGreen)
              .pipe(Effect.result);
            expect(Result.isFailure(failed)).toBe(true);
            if (Result.isFailure(failed))
              expect(failed.failure).toMatchObject({
                _tag: "Fly.InvalidDeployment",
              });
            expect(
              proxy.events.some(
                (event) =>
                  event.method !== "GET" &&
                  /\/(machines|volumes)(\/|$)/.test(event.path),
              ),
            ).toBe(false);
            expect(yield* census(app.appName)).toHaveLength(0);
            expect(
              yield* machines.listVolumes({ app_name: app.appName }),
            ).toHaveLength(0);
            yield* Effect.sync(() => {
              endpoint = undefined;
            });
            yield* stack.destroy();
            yield* assertAppGone(app.appName);
          }).pipe(
            Effect.scoped,
            Effect.ensuring(
              Effect.sync(() => {
                endpoint = undefined;
              }),
            ),
          ),
        { tags: ["provider:fly:volume"], timeout: 300_000 },
      );
    });
  },
);

describe.sequential(
  "workers",
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:redis",
      "provider:fly:secret",
      "provider:fly:service",
      "live",
    ],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });

    // Cold gateway/worker publication, readiness, replacement and census can exceed three minutes.
    const timeout = 480_000;

    describe.sequential("Fly durable worker acceptance", () => {
      for (const mode of ["stop-delay", "stop-fail", "stop-hang"]) {
        test.provider(
          `R05 live ${mode} preserves another worker and bounds managed shutdown`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const scenario = yield* makeScenario(stack);
              yield* Effect.gen(function* () {
                const first = yield* scenario.deploy({
                  version: "one",
                  timeout: "10 seconds",
                  signal: "SIGTERM",
                  runOnly: true,
                  mode,
                  workers: 2,
                });
                const worker = yield* requireValue(
                  first.worker,
                  "worker output",
                );
                const machineId = worker.machineId;
                const observe = <A, E, R>(
                  phase: string,
                  effect: Effect.Effect<A, E, R>,
                ) =>
                  Effect.gen(function* () {
                    const started = yield* Clock.currentTimeMillis;
                    yield* Effect.logInfo("R05 phase started", {
                      mode,
                      machineId,
                      phase,
                    });
                    return yield* effect.pipe(
                      Effect.onExit((exit) =>
                        Clock.currentTimeMillis.pipe(
                          Effect.flatMap((finished) =>
                            Effect.logInfo("R05 phase finished", {
                              mode,
                              machineId,
                              phase,
                              success: Exit.isSuccess(exit),
                              elapsedMs: finished - started,
                            }),
                          ),
                        ),
                      ),
                    );
                  });
                yield* observe(
                  "both-workers-ready-ledger",
                  scenario.wait(
                    first.ledgerUrl,
                    (ledger) =>
                      ledger.events.filter(
                        (event) =>
                          event.machine === machineId &&
                          event.event === "worker-ready",
                      ).length === 2,
                  ),
                );
                yield* observe(
                  "stop-machine-request",
                  machines.stopMachine({
                    app_name: first.workerApp.appName,
                    machine_id: machineId,
                  }),
                );
                const stopped = yield* observe(
                  "stopped-machine-observation",
                  machines
                    .getMachine({
                      app_name: first.workerApp.appName,
                      machine_id: machineId,
                    })
                    .pipe(
                      Effect.repeat({
                        until: (value) => value.state === "stopped",
                        times: 8,
                        schedule: Schedule.spaced("2 seconds"),
                      }),
                    ),
                );
                expect(stopped.state).toBe("stopped");
                const ledger = yield* observe(
                  "post-stop-ledger-snapshot",
                  scenario.snapshot(first.ledgerUrl),
                );
                assertOrder(
                  ledger.events,
                  machineId,
                  "stopped",
                  "drained",
                  "b",
                );
                assertOrder(
                  ledger.events,
                  machineId,
                  "drained",
                  "client-released",
                  "b",
                );
                const stopStarted = yield* requireValue(
                  ledger.events.find(
                    (event) =>
                      event.machine === machineId &&
                      event.event === "stop-started",
                  ),
                  "worker stop-started event",
                );
                const independentRelease = yield* requireValue(
                  ledger.events.find(
                    (event) =>
                      event.machine === machineId &&
                      event.worker === "b" &&
                      event.event === "client-released",
                  ),
                  "worker b client release event",
                );
                expect(
                  independentRelease.at - stopStarted.at,
                ).toBeGreaterThanOrEqual(0);
                expect(independentRelease.at - stopStarted.at).toBeLessThan(
                  10_000,
                );
                const selected = ledger.events.filter(
                  (event) =>
                    event.machine === machineId && event.worker === "a",
                );
                if (mode === "stop-delay") {
                  const a = yield* requireValue(
                    selected.find((event) => event.event === "stopped"),
                    "worker a stopped event",
                  );
                  const b = yield* requireValue(
                    ledger.events.find(
                      (event) =>
                        event.machine === machineId &&
                        event.worker === "b" &&
                        event.event === "stopped",
                    ),
                    "worker b stopped event",
                  );
                  expect(a.at - b.at).toBeGreaterThan(700);
                  assertOrder(
                    ledger.events,
                    machineId,
                    "stopped",
                    "drained",
                    "a",
                  );
                  assertStopped(ledger.events, machineId);
                } else {
                  expect(
                    selected.some(
                      (event) =>
                        event.event === "stopped" || event.event === "drained",
                    ),
                  ).toBe(false);
                  expect(
                    selected.some(
                      (event) =>
                        event.event ===
                        (mode === "stop-fail" ? "stop-failed" : "stop-started"),
                    ),
                  ).toBe(true);
                }
                if (mode === "stop-hang") {
                  expect(
                    selected.some(
                      (event) =>
                        event.event === "work-closed" ||
                        event.event === "client-released",
                    ),
                  ).toBe(false);
                }
                expect(
                  ledger.events.some(
                    (event) =>
                      event.machine === machineId &&
                      event.event === "shared-closed",
                  ),
                ).toBe(mode !== "stop-hang");
                const exit = stopped.events?.find(
                  (event) => event.type === "exit",
                )?.request as
                  | { exit_event?: { exit_code?: number } }
                  | undefined;
                yield* Effect.logInfo("Observed managed worker exit", {
                  mode,
                  exitCode: exit?.exit_event?.exit_code,
                });
                expect(exit?.exit_event?.exit_code).toBe(
                  mode === "stop-delay" ? 0 : 1,
                );
              }).pipe(Effect.ensuring(scenario.cleanup));
            }),
          { timeout },
        );
      }

      test.provider(
        "R07 authenticated durable Redis Streams gateway",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const scenario = yield* makeScenario(stack);
            yield* Effect.gen(function* () {
              const first = yield* scenario.deploy({
                version: "one",
                timeout: "30 seconds",
                signal: "SIGTERM",
                runOnly: true,
                gatewayOnly: true,
              });
              expect((yield* HttpClient.post(first.ledgerUrl)).status).toBe(
                401,
              );
              const added = yield* scenario
                .call(first.ledgerUrl, "enqueue", ["durable-probe", "quick"])
                .pipe(
                  Effect.retry({
                    times: 8,
                    schedule: Schedule.spaced("1 second"),
                  }),
                );
              expect(typeof added).toBe("string");
              expect(
                yield* scenario.call(first.ledgerUrl, "enqueue", [
                  "durable-probe",
                  "quick",
                ]),
              ).toBe(0);
              const claimed = JSON.parse(
                String(
                  yield* scenario.call(first.ledgerUrl, "claim", [
                    "probe-client",
                    "one",
                  ]),
                ),
              ) as { id: string; job: string };
              expect(claimed.job).toBe("durable-probe");
              expect(
                yield* scenario.call(first.ledgerUrl, "finish", [
                  claimed.id,
                  claimed.job,
                  "probe-client",
                ]),
              ).toBe(1);
              const ledger = yield* scenario.settle(first.ledgerUrl);
              expect(ledger.pending).toBe(0);
              expect(ledger.results).toContain("durable-probe");
            }).pipe(Effect.ensuring(scenario.cleanup));
          }),
        { timeout },
      );

      for (const raw of [false, true]) {
        test.provider(
          `R07 ${raw ? "raw" : "managed"} private worker checkpoints and reclaims through replacement with producer overlap`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const scenario = yield* makeScenario(stack);
              yield* Effect.gen(function* () {
                const options = {
                  raw,
                  runOnly: true,
                  timeout: "30 seconds" as const,
                  signal: "SIGTERM" as const,
                  mode: "checkpoint",
                };
                const first = yield* scenario.deploy({
                  ...options,
                  version: "one",
                });
                const oldWorker = yield* requireValue(
                  first.worker,
                  "initial worker output",
                );
                const oldId = oldWorker.machineId;
                yield* scenario.call(first.ledgerUrl, "enqueue", [
                  "checkpoint-job",
                  "checkpoint",
                ]);
                yield* scenario.wait(first.ledgerUrl, (ledger) =>
                  ledger.events.some(
                    (event) =>
                      event.machine === oldId &&
                      event.event === "claimed" &&
                      event.job === "checkpoint-job",
                  ),
                );
                const second = yield* scenario.deploy({
                  ...options,
                  version: "two",
                  mode: "drain",
                  signal: "SIGINT",
                });
                const newWorker = yield* requireValue(
                  second.worker,
                  "replacement worker output",
                );
                const newId = newWorker.machineId;
                yield* assertReplacement(first.workerApp.appName, oldId, newId);
                const ledger = yield* scenario.settle(first.ledgerUrl);
                expect(ledger.results).toContain("checkpoint-job");
                expect(ledger.checkpoints).toContain("saved-step-1");
                expect(
                  ledger.events.some(
                    (event) =>
                      event.event === "reclaimed" &&
                      event.machine === newId &&
                      event.job === "checkpoint-job",
                  ),
                ).toBe(true);
                const ack = ledger.events.filter(
                  (event) =>
                    event.event === "acked" && event.job === "checkpoint-job",
                );
                expect(ack).toHaveLength(1);
                expect(ack[0]?.ack).toBe(1);
                expect(ack[0]?.fresh).toBe(1);
                assertStopped(ledger.events, oldId);
                assertOrder(ledger.events, oldId, "stopped", "checkpoint");
                assertOrder(
                  ledger.events,
                  oldId,
                  "checkpoint",
                  "client-released",
                );
                assertOrder(
                  ledger.events,
                  oldId,
                  "client-released",
                  "shared-closed",
                );
                const oldSlots = new Set(
                  ledger.events
                    .filter(
                      (event) =>
                        event.machine === oldId && event.event === "producer",
                    )
                    .map((event) => event.job),
                );
                const overlaps = ledger.events.filter(
                  (event) =>
                    event.machine === newId &&
                    event.event === "producer" &&
                    oldSlots.has(event.job),
                );
                expect(overlaps.length).toBeGreaterThan(0);
                for (const event of overlaps) {
                  expect(
                    ledger.events.filter(
                      (row) =>
                        row.event === "producer" &&
                        row.job === event.job &&
                        row.fresh === 1,
                    ),
                  ).toHaveLength(1);
                }
              }).pipe(Effect.ensuring(scenario.cleanup));
            }),
          { timeout },
        );
      }
    });
  },
);

describe.sequential(
  "multi-container",
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });
    const firstImage =
      "docker-hub-mirror.fly.io/library/nginx@sha256:7396be67b6f53012a5cf955fa9040619294c25ccacf11e22af5de1b572fc756e";
    const nextImage =
      "docker-hub-mirror.fly.io/library/nginx@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6";

    interface GroupOptions {
      count?: number;
      /** Reverse declaration order and add empty optional fields. */
      reordered?: boolean;
      /** Add a third container to the group. */
      extra?: boolean;
      badHealth?: boolean;
      strategy?: "rolling" | "bluegreen";
    }

    const containers = (
      sidecarImage: string,
      { reordered = false, extra = false }: GroupOptions,
    ): MachineContainer[] => {
      const group: MachineContainer[] = [
        {
          name: "web",
          image: firstImage,
          healthChecks: [
            {
              name: "web-tcp",
              kind: "readiness",
              tcp: { port: 80 },
              interval: 5,
              timeout: 2,
            },
          ],
        },
        {
          name: "sidecar",
          image: sidecarImage,
          cmd: [
            "sh",
            "-c",
            "sed -i 's/80/8080/g' /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'",
          ],
          dependsOn: [{ name: "web", condition: "healthy" }],
          healthChecks: [
            {
              name: "sidecar-tcp",
              kind: "readiness",
              tcp: { port: 8080 },
              interval: 5,
              timeout: 2,
            },
          ],
        },
        ...(extra
          ? [
              {
                name: "extra",
                image: firstImage,
                cmd: ["sh", "-c", "sleep infinity"],
              },
            ]
          : []),
      ];
      return reordered
        ? group.reverse().map((container) => ({ ...container, env: {} }))
        : group;
    };

    const machineChecks = (badHealth: boolean) => ({
      web: { type: "tcp" as const, port: 80, interval: "2s", timeout: "1s" },
      sidecar: {
        type: "tcp" as const,
        port: badHealth ? 9999 : 8080,
        interval: "2s",
        timeout: "1s",
      },
    });

    const deployGroup = (
      stack: ScratchStack,
      sidecarImage: string,
      options: GroupOptions = {},
    ) =>
      stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("MultiContainerBlueGreenSite");
          return yield* Fly.Machine("Group", {
            app,
            region: "fra",
            count: options.count ?? 1,
            guest: { cpus: 1, memoryMb: 256 },
            containers: containers(sidecarImage, options),
            checks: machineChecks(options.badHealth ?? false),
            deploy: {
              strategy: options.strategy ?? "bluegreen",
              healthTimeout: options.badHealth ? "15 seconds" : "30 seconds",
            },
            shutdown: { signal: "SIGTERM", timeout: "1 second" },
          });
        }),
      );

    const images = (machine: Machine) =>
      (machine.config?.containers ?? [])
        .map(({ name, image }) => ({ name, image }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

    const appGone = (appName: string) =>
      machines.getApp({ app_name: appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );

    const machineGone = (appName: string, machineId: string) =>
      machines.getMachine({ app_name: appName, machine_id: machineId }).pipe(
        Effect.map((machine) => machine.state === "destroyed"),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
          until: (gone) => gone,
        }),
      );

    test.provider(
      "checks two named-container replicas and ignores declaration order and empty fields",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const first = yield* deployGroup(stack, firstImage, { count: 2 });
          expect(first.machineIds).toHaveLength(2);
          const observed = yield* Effect.forEach(first.machineIds, (id) =>
            machines.getMachine({ app_name: first.appName, machine_id: id }),
          );
          for (const machine of observed) {
            expect(images(machine)).toEqual([
              { name: "sidecar", image: firstImage },
              { name: "web", image: firstImage },
            ]);
            expect(machine.cordoned).toBe(false);
            expect(machine.config?.metadata?.[keys.phase]).toBe("active");
            expect(machine.config?.metadata?.[keys.protocol]).toBe("2");
            const ready = yield* waitHealthy(first.appName, machine, 30_000);
            for (const check of ["web", "sidecar"])
              expect(
                ready.checks?.some(
                  ({ name, status }) => name === check && status === "passing",
                ),
              ).toBe(true);
          }
          const reordered = yield* deployGroup(stack, firstImage, {
            count: 2,
            reordered: true,
          });
          expect([...reordered.machineIds].sort()).toEqual(
            [...first.machineIds].sort(),
          );
          for (const machine of observed) {
            const after = yield* machines.getMachine({
              app_name: first.appName,
              machine_id: machine.id!,
            });
            expect(after.instance_id).toBe(machine.instance_id);
          }
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "named group transitions from rolling to blue/green and back",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rolling = yield* deployGroup(stack, firstImage, {
            strategy: "rolling",
          });
          const promoted = yield* deployGroup(stack, firstImage);
          expect(promoted.machineId).not.toBe(rolling.machineId);
          const promotedMachine = yield* machines.getMachine({
            app_name: promoted.appName,
            machine_id: promoted.machineId,
          });
          expect(promotedMachine.config?.metadata?.[keys.protocol]).toBe("2");
          expect(images(promotedMachine)).toEqual([
            { name: "sidecar", image: firstImage },
            { name: "web", image: firstImage },
          ]);
          const optedOut = yield* deployGroup(stack, firstImage, {
            strategy: "rolling",
          });
          expect(optedOut.machineId).toBe(promoted.machineId);
          const live = yield* machines.getMachine({
            app_name: optedOut.appName,
            machine_id: optedOut.machineId,
          });
          expect(live.config?.metadata?.[keys.protocol]).toBeUndefined();
          expect(images(live)).toEqual([
            { name: "sidecar", image: firstImage },
            { name: "web", image: firstImage },
          ]);
          yield* stack.destroy();
          expect(yield* appGone(rolling.appName)).toBe(true);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "a single-image blue/green generation is replaced by a named group",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const single = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("MultiContainerBlueGreenSite");
              return yield* Fly.Machine("Group", {
                app,
                region: "fra",
                guest: { cpus: 1, memoryMb: 256 },
                image: firstImage,
                checks: { web: machineChecks(false).web },
                deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
                shutdown: { signal: "SIGTERM", timeout: "1 second" },
              });
            }),
          );
          const before = yield* machines.getMachine({
            app_name: single.appName,
            machine_id: single.machineId,
          });
          expect(before.config?.metadata?.[keys.protocol]).toBe("1");
          const group = yield* deployGroup(stack, firstImage);
          expect(group.machineId).not.toBe(single.machineId);
          const after = yield* machines.getMachine({
            app_name: group.appName,
            machine_id: group.machineId,
          });
          expect(after.config?.metadata?.[keys.protocol]).toBe("2");
          expect(after.config?.metadata?.[keys.phase]).toBe("active");
          expect(images(after)).toEqual([
            { name: "sidecar", image: firstImage },
            { name: "web", image: firstImage },
          ]);
          expect(yield* machineGone(single.appName, single.machineId)).toBe(
            true,
          );
          yield* stack.destroy();
          expect(yield* appGone(single.appName)).toBe(true);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "changing one image or adding a container replaces the whole group",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const first = yield* deployGroup(stack, firstImage);
          const updated = yield* deployGroup(stack, nextImage, {
            reordered: true,
          });
          expect(updated.machineId).not.toBe(first.machineId);
          const replacement = yield* machines.getMachine({
            app_name: updated.appName,
            machine_id: updated.machineId,
          });
          expect(images(replacement)).toEqual([
            { name: "sidecar", image: nextImage },
            { name: "web", image: firstImage },
          ]);
          expect(replacement.cordoned).toBe(false);
          expect(replacement.config?.metadata?.[keys.phase]).toBe("active");
          expect(yield* machineGone(first.appName, first.machineId)).toBe(true);

          const extended = yield* deployGroup(stack, nextImage, {
            extra: true,
          });
          expect(extended.machineId).not.toBe(updated.machineId);
          expect(
            images(
              yield* machines.getMachine({
                app_name: extended.appName,
                machine_id: extended.machineId,
              }),
            ),
          ).toEqual([
            { name: "extra", image: firstImage },
            { name: "sidecar", image: nextImage },
            { name: "web", image: firstImage },
          ]);
          expect(yield* machineGone(updated.appName, updated.machineId)).toBe(
            true,
          );
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "bad secondary readiness preserves the serving predecessor",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const first = yield* deployGroup(stack, firstImage);
          const failed = yield* deployGroup(stack, nextImage, {
            badHealth: true,
          }).pipe(Effect.result);
          expect(Result.isFailure(failed)).toBe(true);
          const predecessor = yield* machines.getMachine({
            app_name: first.appName,
            machine_id: first.machineId,
          });
          expect(predecessor.state).toBe("started");
          expect(predecessor.cordoned).toBe(false);
          expect(predecessor.config?.metadata?.[keys.phase]).toBe("active");
          expect(images(predecessor)).toEqual([
            { name: "sidecar", image: firstImage },
            { name: "web", image: firstImage },
          ]);
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "tampered deployment metadata preserves the serving group",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const first = yield* deployGroup(stack, firstImage);
          const target = {
            app_name: first.appName,
            machine_id: first.machineId,
          };
          const original = yield* machines.getMachine(target);
          const tamperings: Array<[string, Record<string, string>]> = [
            ["unknown protocol", { [keys.protocol]: "future" }],
            [
              "incomplete image set",
              {
                [keys.containerImageSet]: JSON.stringify([
                  { name: "web", image: firstImage },
                ]),
              },
            ],
          ];
          for (const [label, overrides] of tamperings) {
            // Rewrite Alchemy's ownership metadata directly through the Fly API.
            const current = yield* machines.getMachine(target);
            const tampered = yield* machines.updateMachine({
              ...target,
              config: {
                ...current.config,
                metadata: { ...original.config?.metadata, ...overrides },
              },
            });
            yield* machines.waitMachine({
              ...target,
              state: "started",
              instance_id: tampered.instance_id,
              timeout: 30,
            });
            const failed = yield* deployGroup(stack, nextImage).pipe(
              Effect.flip,
            );
            expect(failed, label).toBeInstanceOf(DeploymentRecoveryAmbiguous);
            const preserved = yield* machines.getMachine(target);
            expect(preserved.instance_id, label).toBe(tampered.instance_id);
            expect(preserved.state, label).toBe("started");
            expect(images(preserved), label).toEqual([
              { name: "sidecar", image: firstImage },
              { name: "web", image: firstImage },
            ]);
            const inventory = (yield* machines.listMachines({
              app_name: first.appName,
            })).filter((machine) => machine.state !== "destroyed");
            expect(
              inventory.map(({ id }) => id),
              label,
            ).toEqual([first.machineId]);
          }
          const restored = yield* machines.updateMachine({
            ...target,
            config: {
              ...(yield* machines.getMachine(target)).config,
              metadata: original.config?.metadata,
            },
          });
          yield* machines.waitMachine({
            ...target,
            state: "started",
            instance_id: restored.instance_id,
            timeout: 30,
          });
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 180_000 },
    );
  },
);

describe.sequential(
  "multi-container public traffic",
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
  },
  () => {
    const { test } = Test.make({ providers: Fly.providers() });
    const image =
      "docker-hub-mirror.fly.io/library/node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85";

    const scenario = (stack: ScratchStack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const script = yield* fs.readFileString(
          yield* path.fromFileUrl(
            new URL("./fixtures/multi-container-http.ts", import.meta.url),
          ),
        );
        return (version: string, badHealth = false) =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("Traffic");
              yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
              return yield* Fly.Machine("Group", {
                app,
                region: "fra",
                guest: { cpus: 1, memoryMb: 256 },
                containers: [
                  {
                    name: "web",
                    image,
                    cmd: [
                      "node",
                      "--input-type=module-typescript",
                      "-e",
                      script,
                    ],
                    env: {
                      PORT: "3000",
                      CONTAINER_NAME: "web",
                      VERSION: version,
                    },
                  },
                  {
                    name: "sidecar",
                    image,
                    cmd: [
                      "node",
                      "--input-type=module-typescript",
                      "-e",
                      script,
                    ],
                    env: {
                      PORT: "3001",
                      CONTAINER_NAME: "sidecar",
                      VERSION: version,
                      BAD_HEALTH: String(badHealth),
                    },
                    dependsOn: [{ name: "web", condition: "started" }],
                  },
                ],
                checks: {
                  sidecar: {
                    type: "http",
                    port: 3001,
                    path: "/health",
                    interval: "2s",
                    timeout: "1s",
                  },
                },
                services: [
                  {
                    protocol: "tcp",
                    internalPort: 3000,
                    ports: [{ port: 443, handlers: ["tls", "http"] }],
                    checks: [
                      {
                        type: "http",
                        port: 3000,
                        path: "/health",
                        interval: "2s",
                        timeout: "1s",
                      },
                    ],
                    autostop: "off",
                  },
                ],
                deploy: {
                  strategy: "bluegreen",
                  healthTimeout: badHealth ? "15 seconds" : "30 seconds",
                },
                shutdown: { signal: "SIGTERM", timeout: "10 seconds" },
              });
            }),
          );
      });

    const request = (appName: string, route = "/") =>
      HttpClient.get(`https://${appName}.fly.dev${route}`, {
        headers: { connection: "close" },
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Public HTTP ${response.status}`)),
        ),
        Effect.timeout("5 seconds"),
      );
    const version = (appName: string) =>
      request(appName).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("5 seconds"),
      );
    const sampleTraffic = (appName: string) =>
      Effect.gen(function* () {
        const samples = yield* Ref.make<string[]>([]);
        const finished = yield* Ref.make(false);
        const fiber = yield* Stream.range(0, 359).pipe(
          Stream.mapEffect(() =>
            version(appName).pipe(
              Effect.result,
              Effect.flatMap((result) =>
                Ref.update(samples, (values) => [
                  ...values,
                  Result.isSuccess(result) ? result.success : "HTTP failure",
                ]),
              ),
              Effect.andThen(Effect.sleep("250 millis")),
              Effect.andThen(Ref.get(finished)),
            ),
          ),
          Stream.takeUntil((done) => done),
          Stream.runDrain,
          Effect.forkScoped,
        );
        return Effect.gen(function* () {
          yield* Ref.set(finished, true);
          yield* Fiber.join(fiber);
          return yield* Ref.get(samples);
        });
      });
    const appGone = (appName: string) =>
      machines.getApp({ app_name: appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
    const deployServing = (stack: ScratchStack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deploy = yield* scenario(stack);
        const first = yield* deploy("old");
        expect(
          yield* version(first.appName).pipe(
            Effect.retry({ times: 8, schedule: Schedule.spaced("1 second") }),
          ),
        ).toBe("old");
        return { first, deploy };
      });

    test.provider(
      "public replacement drains in-flight requests in both containers after SIGTERM",
      (stack) =>
        Effect.gen(function* () {
          const { first, deploy } = yield* deployServing(stack);
          const finishTraffic = yield* sampleTraffic(first.appName);
          // Headers arrive only once the request is held inside each container.
          const web = yield* request(first.appName, "/hold");
          const sidecar = yield* request(first.appName, "/sidecar/hold");
          const webBody = yield* web.text.pipe(
            Effect.timeout("90 seconds"),
            Effect.forkScoped,
          );
          const sidecarBody = yield* sidecar.text.pipe(
            Effect.timeout("90 seconds"),
            Effect.forkScoped,
          );
          const second = yield* deploy("new");
          expect(second.machineId).not.toBe(first.machineId);
          for (const [name, body] of [
            ["web", yield* Fiber.join(webBody)],
            ["sidecar", yield* Fiber.join(sidecarBody)],
          ]) {
            expect(body).toBe(
              "waiting\n" +
                JSON.stringify({
                  machine: first.machineId,
                  name,
                  version: "old",
                  signal: "SIGTERM",
                }),
            );
          }
          expect(yield* version(first.appName)).toBe("new");
          // Include a post-cutover sample before joining the continuous probe.
          yield* Effect.sleep("500 millis");
          const samples = yield* finishTraffic;
          expect(samples).toContain("old");
          expect(samples).toContain("new");
          expect(
            samples.every((sample) => sample === "old" || sample === "new"),
          ).toBe(true);
          const oldGone = yield* machines
            .getMachine({
              app_name: first.appName,
              machine_id: first.machineId,
            })
            .pipe(
              Effect.map((machine) => machine.state === "destroyed"),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            );
          expect(oldGone).toBe(true);
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 300_000 },
    );

    test.provider(
      "unhealthy container candidates never receive public traffic",
      (stack) =>
        Effect.gen(function* () {
          const { first, deploy } = yield* deployServing(stack);
          const finishTraffic = yield* sampleTraffic(first.appName);
          const failed = yield* deploy("unready", true).pipe(Effect.flip);
          expect(failed).toBeInstanceOf(ReplicaChecksNotPassing);
          if (failed instanceof ReplicaChecksNotPassing) {
            expect(failed.machineId).not.toBe(first.machineId);
            expect(
              failed.checks.some(
                (check) =>
                  check.name === "sidecar" && check.status !== "passing",
              ),
            ).toBe(true);
          }
          expect(yield* version(first.appName)).toBe("old");
          const samples = yield* finishTraffic;
          expect(samples.length).toBeGreaterThan(1);
          expect([...new Set(samples)]).toEqual(["old"]);
          const old = yield* machines.getMachine({
            app_name: first.appName,
            machine_id: first.machineId,
          });
          expect(old.state).toBe("started");
          expect(old.cordoned).toBe(false);
          yield* stack.destroy();
          expect(yield* appGone(first.appName)).toBe(true);
        }),
      { timeout: 300_000 },
    );
  },
);
