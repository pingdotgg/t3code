import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SshPasswordPrompt } from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import { SshEnvironmentManager } from "./tunnel.ts";
import {
  commandArgs,
  makeRunningProcess,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
} from "./tunnelFixtures.ts";

describe("SSH environment lifecycle", () => {
  it.effect.each([
    { stage: "port", kind: "managed", stopFails: false },
    { stage: "port", kind: "external", stopFails: false },
    { stage: "readiness", kind: "managed", stopFails: false },
    { stage: "readiness", kind: "external", stopFails: false },
    { stage: "port", kind: "managed", stopFails: true },
    { stage: "complete", kind: "managed", stopFails: false },
  ] as const)(
    "releases a launched $kind server when shutdown reaches $stage setup, stop fails: $stopFails",
    ({ stage, kind, stopFails }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const pause = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        let stops = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeSuccessfulProcess("");
            if (args.includes("--"))
              return makeSuccessfulProcess(`{"remotePort":3773,"serverKind":"${kind}"}`);
            if (args.includes("-N")) return makeRunningProcess(() => {});
            stops += 1;
            const process = makeSuccessfulProcess("");
            return stopFails
              ? { ...process, exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }
              : process;
          }),
        );
        const services = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(
            HttpClient.HttpClient,
            stage === "readiness" ? HttpClient.make(() => pause) : testHttpClient,
          ),
          Layer.succeed(NetService.NetService, {
            ...testNetService,
            reserveLoopbackPort: () => (stage === "port" ? pause : Effect.succeed(41773)),
          }),
          SshPasswordPrompt.disabledLayer,
        );
        yield* Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const context = yield* Layer.buildWithScope(
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
            }),
            scope,
          );
          const manager = yield* SshEnvironmentManager.pipe(Effect.provide(context));
          const request = yield* Effect.forkChild(
            manager.ensureEnvironment({
              alias: "fixture",
              hostname: "fixture",
              username: null,
              port: null,
            }),
          );
          if (stage === "complete") {
            yield* Fiber.join(request);
          } else {
            yield* Effect.raceFirst(
              Deferred.await(started),
              Fiber.join(request).pipe(
                Effect.andThen(Effect.die("Setup completed before the test boundary.")),
              ),
            );
          }
          yield* Scope.close(scope, Exit.void).pipe(Effect.uninterruptible);
          const exit = yield* Fiber.await(request);
          assert.isTrue(stage === "complete" ? Exit.isSuccess(exit) : Exit.hasInterrupts(exit));
          assert.equal(stops, kind === "managed" ? 1 : 0);
          yield* Scope.close(scope, Exit.void);
          assert.equal(stops, kind === "managed" ? 1 : 0);
        }).pipe(Effect.provide(services), Effect.scoped);
      }),
  );
  it.effect.each(["resolution", "readiness", "pairing"] as const)(
    "cancels pending %s before the environment manager finishes shutdown",
    (stage) => {
      let completed = false;
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pause = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        let tunnelCount = 0;
        let killCount = 0;
        let stopCount = 0;
        let pairingStarted = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            if (args.includes("-G")) {
              if (stage === "resolution") yield* pause;
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              tunnelCount += 1;
              return makeRunningProcess(() => {
                killCount += 1;
              });
            }
            if (args.includes("--")) {
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            if (stage === "pairing" && !pairingStarted) {
              pairingStarted = true;
              yield* pause;
              return makeSuccessfulProcess('{"credential":"LCL4R2TPHDKQ"}\n');
            }
            stopCount += 1;
            return makeSuccessfulProcess('{"stopped":true}\n');
          }),
        );
        const httpClient = HttpClient.make((request) =>
          (stage === "readiness" ? pause : Effect.void).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
          ),
        );
        const services = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, httpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshPasswordPrompt.disabledLayer,
        );
        yield* Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const context = yield* Layer.buildWithScope(
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
            }),
            scope,
          );
          const manager = yield* SshEnvironmentManager.pipe(Effect.provide(context));
          const request = yield* Effect.forkChild(
            manager.ensureEnvironment(
              { alias: "devbox", hostname: "devbox", username: null, port: null },
              { issuePairingToken: stage === "pairing" },
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(started);
          yield* Scope.close(scope, Exit.void).pipe(Effect.uninterruptible);
          const killsAtShutdown = killCount;
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.await(request);
          assert.isTrue(Exit.hasInterrupts(exit));
          assert.equal(tunnelCount, stage === "resolution" ? 0 : 1);
          assert.equal(killsAtShutdown, stage === "resolution" ? 0 : 1);
          assert.equal(stopCount, stage === "pairing" ? 1 : 0);
          completed = true;
        }).pipe(Effect.provide(services), Effect.scoped);
      }).pipe(Effect.ensuring(Effect.sync(() => assert.isTrue(completed))));
    },
  );

  it.effect.each(["successful stop", "failed stop"] as const)(
    "preserves an in-flight disconnect through manager shutdown after a %s",
    (mode) => {
      let completed = false;
      return Effect.gen(function* () {
        const stopStarted = yield* Deferred.make<void>();
        const finishStop = yield* Deferred.make<void>();
        let stopCount = 0;
        let killCount = 0;
        let remoteRunning = true;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeSuccessfulProcess("");
            if (args.includes("-N"))
              return makeRunningProcess(() => {
                killCount += 1;
              });
            if (args.includes("--")) return makeSuccessfulProcess('{"remotePort":3773}\n');
            stopCount += 1;
            return {
              ...makeSuccessfulProcess('{"stopped":true}\n'),
              stderr:
                mode === "failed stop"
                  ? Stream.make(new TextEncoder().encode("Remote stop failed.\n"))
                  : Stream.empty,
              exitCode: Deferred.succeed(stopStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishStop)),
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = mode === "failed stop";
                    return ChildProcessSpawner.ExitCode(mode === "failed stop" ? 1 : 0);
                  }),
                ),
              ),
            };
          }),
        );
        const services = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshPasswordPrompt.disabledLayer,
        );
        yield* Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const context = yield* Layer.buildWithScope(
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
            }),
            scope,
          );
          const manager = yield* SshEnvironmentManager.pipe(Effect.provide(context));
          const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(
            manager.disconnectEnvironment(target).pipe(Effect.result),
          );
          yield* Deferred.await(stopStarted);
          yield* Scope.close(scope, Exit.void).pipe(Effect.uninterruptible);
          yield* Deferred.succeed(finishStop, undefined);
          const exit = yield* Fiber.await(disconnect);
          assert.isTrue(Exit.isSuccess(exit));
          if (Exit.isSuccess(exit)) {
            assert.equal(Result.isFailure(exit.value), mode === "failed stop");
            if (Result.isFailure(exit.value)) {
              assert.instanceOf(exit.value.failure, SshCommandError);
              assert.equal(exit.value.failure.message, "Remote stop failed.");
            }
          }
          assert.equal(remoteRunning, mode === "failed stop");
          assert.equal(stopCount, 1);
          assert.equal(killCount, 1);
          completed = true;
        }).pipe(Effect.provide(services), Effect.scoped);
      }).pipe(Effect.ensuring(Effect.sync(() => assert.isTrue(completed))));
    },
  );

  it.effect("does not start environment setup after the manager closes", () => {
    let completed = false;
    return Effect.gen(function* () {
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawnCount += 1;
          return makeSuccessfulProcess("");
        }),
      );
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const context = yield* Layer.buildWithScope(
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
        }),
        scope,
      );
      const manager = yield* SshEnvironmentManager.pipe(Effect.provide(context));
      yield* Scope.close(scope, Exit.void);
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const services = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
      );
      const result = yield* manager
        .ensureEnvironment(target)
        .pipe(Effect.exit, Effect.provide(services));
      assert.isTrue(Exit.hasInterrupts(result));
      assert.equal(spawnCount, 0);
      completed = true;
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => assert.isTrue(completed))));
  });

  it.effect(
    "cancels an abandoned setup and shares the next tunnel between concurrent callers",
    () => {
      let completed = false;
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let probeCount = 0;
        let tunnelCount = 0;
        let killCount = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-N")) {
              tunnelCount += 1;
              return makeRunningProcess(() => {
                killCount += 1;
              });
            }
            return makeSuccessfulProcess(args.includes("--") ? '{"remotePort":3773}\n' : "");
          }),
        );
        const httpClient = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (++probeCount === 1) {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, httpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
          const first = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(started);
          yield* Fiber.interrupt(first);
          assert.equal(killCount, 1);
          const [second, third] = yield* Effect.all(
            [manager.ensureEnvironment(target), manager.ensureEnvironment(target)],
            { concurrency: "unbounded" },
          );
          assert.equal(second.httpBaseUrl, third.httpBaseUrl);
          assert.equal(tunnelCount, 2);
          assert.equal(killCount, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
        assert.equal(killCount, 2);
        completed = true;
      }).pipe(Effect.ensuring(Effect.sync(() => assert.isTrue(completed))));
    },
  );

  it.effect("waits for pending setup before disconnecting its tunnel", () => {
    let completed = false;
    return Effect.gen(function* () {
      const readyStarted = yield* Deferred.make<void>();
      const finishReady = yield* Deferred.make<void>();
      const disconnectStarted = yield* Deferred.make<void>();
      let resolutions = 0;
      let stopCount = 0;
      let killCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            if (++resolutions === 2) yield* Deferred.succeed(disconnectStarted, undefined);
            return makeSuccessfulProcess("");
          }
          if (args.includes("-N"))
            return makeRunningProcess(() => {
              killCount += 1;
            });
          if (args.includes("--")) return makeSuccessfulProcess('{"remotePort":3773}\n');
          stopCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }),
      );
      const httpClient = HttpClient.make((request) =>
        Deferred.succeed(readyStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishReady)),
          Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ archiveVersion: "1.2.3" }),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const setup = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(readyStarted);
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
        yield* Deferred.await(disconnectStarted);
        assert.equal(stopCount, 0);
        yield* Deferred.succeed(finishReady, undefined);
        yield* Fiber.join(setup);
        yield* Fiber.join(disconnect);
        assert.equal(stopCount, 1);
        assert.equal(killCount, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(stopCount, 1);
      assert.equal(killCount, 1);
      completed = true;
    }).pipe(Effect.ensuring(Effect.sync(() => assert.isTrue(completed))));
  });
});
