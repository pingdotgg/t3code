import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TurnAdmissionGate from "../orchestration/TurnAdmissionGate.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import {
  PENDING_TURN_RECOVERY_PROTOCOL,
  PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
} from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked" | "unsafe";
  readonly activeWorkByCheck?: ReadonlyArray<number>;
  readonly activeLatestTurnByCheck?: ReadonlyArray<boolean>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly commitUpdateHandoff?: TurnAdmissionGate.TurnAdmissionGate["Service"]["commitUpdateHandoff"];
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
          };
        }
        order.push("preflight");
        const readyResult = {
          status: "ready",
          version: "1.1.0",
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
          ...(options.preflight === "unsafe"
            ? {}
            : {
                providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
                pendingTurnRecoveryProtocol: PENDING_TURN_RECOVERY_PROTOCOL,
              }),
        };
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : readyResult;
        return {
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
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
  let activeWorkCheck = 0;
  const projectionSnapshotQuery = {
    getShellSnapshot: () => {
      const configured = options.activeWorkByCheck ?? [0];
      const activeWorkCount = configured[Math.min(activeWorkCheck, configured.length - 1)] ?? 0;
      const latestTurnConfigured = options.activeLatestTurnByCheck ?? [false];
      const hasActiveLatestTurn =
        latestTurnConfigured[Math.min(activeWorkCheck, latestTurnConfigured.length - 1)] ?? false;
      activeWorkCheck += 1;
      return Effect.succeed({
        threads: Array.from(
          { length: Math.max(activeWorkCount, hasActiveLatestTurn ? 1 : 0) },
          (_, index) => ({
            id: `thread-${index}`,
            session: { status: index < activeWorkCount ? "running" : "ready" },
            latestTurn: hasActiveLatestTurn ? { state: "running" } : null,
            backgroundLiveness: null,
          }),
        ),
      });
    },
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  const baseTurnAdmissionGate = yield* TurnAdmissionGate.make;
  const turnAdmissionGate = TurnAdmissionGate.TurnAdmissionGate.of({
    ...baseTurnAdmissionGate,
    commitUpdateHandoff:
      options.commitUpdateHandoff ??
      ((handoff) =>
        Effect.sync(() => order.push("gate")).pipe(
          Effect.andThen(baseTurnAdmissionGate.commitUpdateHandoff(handoff)),
        )),
  });
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projectionSnapshotQuery),
    Effect.provideService(TurnAdmissionGate.TurnAdmissionGate, turnAdmissionGate),
    Effect.provideService(HostProcessExecutablePath, "/usr/bin/node"),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return { selfUpdate, order, turnAdmissionGate };
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
      expect(order).toEqual(["install", "preflight", "gate", "accept"]);
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

  it.effect("refuses to restart the server while a thread is active", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ activeWorkByCheck: [1] });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "T3 Code cannot update while 1 thread is still working. Let the work finish or stop it, then retry.",
      );
      expect(order).toEqual([]);
    }),
  );

  it.effect("rechecks for work that starts while the update is staging", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ activeWorkByCheck: [0, 1] });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "T3 Code cannot update while 1 thread is still working. Let the work finish or stop it, then retry.",
      );
      expect(order).toEqual(["install", "preflight", "gate"]);
    }),
  );

  it.effect("treats a projected turn as active before the provider session catches up", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        activeLatestTurnByCheck: [true],
      });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "T3 Code cannot update while 1 thread is still working. Let the work finish or stop it, then retry.",
      );
      expect(order).toEqual([]);
    }),
  );

  it.effect("refuses an update that would remove provider lifecycle recovery", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ preflight: "unsafe" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "This T3 Code release does not include the required automatic provider lifecycle recovery. The current server was kept running.",
      );
      expect(order).toEqual(["install", "preflight"]);
    }),
  );

  it.effect("keeps turn admission open when launcher handoff fails", () =>
    Effect.gen(function* () {
      const { selfUpdate, turnAdmissionGate } = yield* makeHarness({
        requestUpdate: ({ targetVersion }) =>
          Effect.fail(
            new ServiceLauncherClient.ServiceLauncherRejectedError({
              targetVersion,
              reason: "launcher refused the candidate",
            }),
          ),
      });

      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "launcher refused the candidate",
      );
      expect(
        yield* turnAdmissionGate.admitTurn(
          Effect.succeed("admitted"),
          () =>
            new ServiceLauncherClient.ServiceLauncherRejectedError({
              targetVersion: "1.1.0",
              reason: "turn admission stayed closed",
            }),
        ),
      ).toBe("admitted");
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
