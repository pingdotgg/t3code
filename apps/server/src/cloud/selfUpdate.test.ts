import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerAutomaticUpdateDeferredError, ServerSelfUpdateError } from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly automaticUpdateIdle?: (
    order: string[],
    targetVersion: string,
  ) => Effect.Effect<void, ServerSelfUpdateError | ServerAutomaticUpdateDeferredError>;
  readonly install?: (order: string[]) => Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
}

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "npm") {
          order.push("install");
          yield* options.install?.(order) ?? Effect.void;
          const prefix = input.args[input.args.indexOf("--prefix") + 1];
          if (prefix === undefined) return yield* Effect.die("missing npm prefix");
          const entry = path.join(prefix, "node_modules", "t3", "dist", "bin.mjs");
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
          yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.sync((): undefined => undefined),
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(HostProcessExecutablePath, "/usr/bin/node"),
    Effect.provideService(
      ServerSelfUpdate.ServerSelfUpdateIdleCheck,
      ServerSelfUpdate.ServerSelfUpdateIdleCheck.of({
        assertIdle: (targetVersion) =>
          options.automaticUpdateIdle?.(order, targetVersion) ?? Effect.void,
      }),
    ),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return { selfUpdate, order };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["install", "preflight", "accept"]);
    }),
  );

  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "local update required",
      );
    }),
  );

  it.effect("rejects automatic downgrades before staging", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      const error = yield* selfUpdate
        .update({ targetVersion: "0.0.1", automatic: true })
        .pipe(Effect.flip);

      expect(error.reason).toContain("newer version");
      expect(order).toEqual([]);
    }),
  );

  it.effect("suppresses repeated automatic attempts after failure until a manual retry", () =>
    Effect.gen(function* () {
      let requests = 0;
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ServiceLauncherClient.ServiceLauncherClientError({ operation: "send" }),
              ),
            ),
          ),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true }).pipe(Effect.flip);
      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true }).pipe(Effect.flip);
      expect(requests).toBe(1);

      yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip);
      expect(requests).toBe(1);
      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true }).pipe(Effect.flip);
      expect(requests).toBe(1);

      yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      expect(requests).toBe(2);
    }),
  );

  it.effect("does not wedge updates when a manual retry is interrupted", () =>
    Effect.gen(function* () {
      const retryStarted = yield* Deferred.make<void>();
      const releaseRetry = yield* Deferred.make<void>();
      let requests = 0;
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ServiceLauncherClient.ServiceLauncherClientError({ operation: "send" }),
              ),
            ),
          ),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true }).pipe(Effect.flip);
      const retryFiber = yield* selfUpdate
        .update({ targetVersion: "1.1.0" }, () =>
          Deferred.succeed(retryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRetry)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(retryStarted);
      const interruptFiber = yield* Fiber.interrupt(retryFiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseRetry, undefined);
      yield* Fiber.join(interruptFiber);

      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true }).pipe(Effect.flip);
      expect(requests).toBe(1);
      yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      expect(requests).toBe(2);
    }),
  );

  it.effect("rechecks automatic updates after staging and before activation", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        automaticUpdateIdle: (order, targetVersion) =>
          Effect.sync(() => order.push("idle-check")).pipe(
            Effect.andThen(
              new ServerAutomaticUpdateDeferredError({
                reason: "new work started while downloading",
                targetVersion,
              }),
            ),
          ),
      });
      const error = yield* selfUpdate
        .update({ targetVersion: "1.1.0", automatic: true })
        .pipe(Effect.flip);

      expect(error.reason).toContain("new work started");
      expect(order).toEqual(["install", "preflight", "idle-check"]);
    }),
  );

  it.effect("keeps admission closed if an automatic update caller disconnects during handoff", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRequest)),
            Effect.as("launcher-id"),
          ),
      });
      const updateFiber = yield* selfUpdate
        .update({ targetVersion: "1.1.0", automatic: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requestStarted);
      const interruptFiber = yield* Fiber.interrupt(updateFiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const duringHandoff = yield* selfUpdate
        .withCommandAdmission(Effect.succeed("started"))
        .pipe(Effect.flip);
      expect(duringHandoff.reason).toContain("cannot start new work");

      yield* Deferred.succeed(releaseRequest, undefined);
      yield* Fiber.join(interruptFiber);
      const afterAcceptance = yield* selfUpdate
        .withCommandAdmission(Effect.succeed("started"))
        .pipe(Effect.flip);
      expect(afterAcceptance.reason).toContain("cannot start new work");
      expect(order).toEqual(["install", "preflight"]);
    }),
  );

  it.effect("allows automatic update staging to be interrupted before handoff", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      let installs = 0;
      const { selfUpdate, order } = yield* makeHarness({
        install: () => {
          installs += 1;
          return installs === 1
            ? Deferred.succeed(installStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInstall)),
              )
            : Effect.void;
        },
      });
      const updateFiber = yield* selfUpdate
        .update({ targetVersion: "1.1.0", automatic: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(installStarted);
      const interruptFiber = yield* Fiber.interrupt(updateFiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseInstall, undefined);
      yield* Fiber.join(interruptFiber);

      expect(order).toEqual(["install"]);
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
    }),
  );

  it.effect("blocks new commands after an automatic handoff is accepted", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness();
      yield* selfUpdate.update({ targetVersion: "1.1.0", automatic: true });

      const error = yield* selfUpdate
        .withCommandAdmission(Effect.succeed("started"))
        .pipe(Effect.flip);
      expect(error.reason).toContain("cannot start new work");
    }),
  );

  it.effect("keeps command admission open for manual updates", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness();
      yield* selfUpdate.update({ targetVersion: "1.1.0" });
      expect(yield* selfUpdate.withCommandAdmission(Effect.succeed("started"))).toBe("started");
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );
});
