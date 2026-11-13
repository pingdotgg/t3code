// @effect-diagnostics nodeBuiltinImport:off -- real processes stand in for servers and CLIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProviderProcesses from "./providerProcesses.ts";

// Real child processes stand in for servers and CLIs; only PIDs captured at spawn are signalled.
const ownedProcess = Effect.gen(function* () {
  const ready = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<void>();
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", 'process.stdin.resume(); process.send("ready");'],
        { stdio: ["pipe", "ignore", "ignore", "ipc"] },
      );
      child.once("message", () => Deferred.doneUnsafe(ready, Effect.void));
      child.once("error", (error) => Deferred.doneUnsafe(ready, Effect.die(error)));
      child.once("exit", () => Deferred.doneUnsafe(exited, Effect.void));
      return child;
    }),
    (child) =>
      Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(Deferred.await(exited))),
  );
  yield* Deferred.await(ready);
  const pid = child.pid;
  assert(pid !== undefined);
  const controller = AcpSessionRuntime.makePosixProcessTreeController("linux");
  const identity = controller.identity(pid);
  assert(identity !== undefined);
  const boot = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return {
    pid,
    startTime: `${boot}:${identity.startTime}`,
    pgid: 0,
    running: () => {
      const observed = controller.identity(pid);
      return observed !== undefined && !AcpSessionRuntime.posixProcessIsZombie(observed);
    },
    stop: Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(Deferred.await(exited))),
  };
});

describe.runIf(HostProcess.Platform.defaultValue() === "linux")("ProviderProcesses", () => {
  it.live("reaps only recorded CLIs of dead servers before startup completes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const directory = NodePath.join(config.stateDir, "provider-processes");
      NodeFS.mkdirSync(directory, { recursive: true });
      type Identity = { readonly pid: number; readonly startTime: string };
      const record = (owner: Identity, processes: ReadonlyArray<Identity>) => {
        const instanceId = NodeCrypto.randomUUID();
        NodeFS.writeFileSync(
          NodePath.join(directory, `${instanceId}.json`),
          JSON.stringify({
            version: 1,
            instanceId,
            hostname: NodeOS.hostname(),
            stateDir: config.stateDir,
            owner: { pid: owner.pid, startTime: owner.startTime },
            processes: processes.map(({ pid, startTime }) => ({ pid, startTime, pgid: 0 })),
          }),
        );
      };
      const reused = (identity: Identity) => ({
        ...identity,
        startTime: identity.startTime.replace(/:\d+$/, ":1"),
      });
      const deadOwner = yield* ownedProcess;
      const liveOwner = yield* ownedProcess;
      const reusedOwner = yield* ownedProcess;
      const liveProvider = yield* ownedProcess;
      const reusedProvider = yield* ownedProcess;
      const orphan = yield* ownedProcess;
      const orphanOfReusedOwner = yield* ownedProcess;
      const unrecorded = yield* ownedProcess;
      record(liveOwner, [liveProvider]);
      record(deadOwner, [reused(reusedProvider)]);
      record(deadOwner, [orphan]);
      record(reused(reusedOwner), [orphanOfReusedOwner]);
      yield* deadOwner.stop;

      const context = yield* Layer.build(ProviderProcesses.layer);
      expect(Context.get(context, ProviderProcesses.ProviderProcesses).hasOtherLiveOwner).toBe(
        true,
      );

      expect({
        orphan: orphan.running(),
        orphanOfReusedOwner: orphanOfReusedOwner.running(),
        liveProvider: liveProvider.running(),
        reusedProvider: reusedProvider.running(),
        reusedOwner: reusedOwner.running(),
        unrecorded: unrecorded.running(),
      }).toEqual({
        orphan: false,
        orphanOfReusedOwner: false,
        liveProvider: true,
        reusedProvider: true,
        reusedOwner: true,
        unrecorded: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-restart-ownership-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
