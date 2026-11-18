// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as RelayClientLedger from "./RelayClientLedger.ts";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const spawnSleep = Effect.acquireRelease(
  Effect.gen(function* () {
    const child = NodeChildProcess.spawn("sleep", ["600"], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) return yield* Effect.die("spawn failed");
    const exited = yield* Deferred.make<void>();
    child.once("exit", () => Deferred.doneUnsafe(exited, Effect.void));
    return {
      pid,
      kill: Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(Deferred.await(exited))),
    };
  }),
  ({ kill }) => kill,
);

const entryNames = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readDirectory(path.join(stateDir, "relay-clients"))
      .pipe(Effect.orElseSucceed(() => []));
  });

const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

describe.each(observedPlatforms)("RelayClientLedger observing as %s", (platform) => {
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(NodeServices.layer),
    );

  it.live("stops a client left by a dead server and keeps one whose server still runs", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
        const deadOwner = yield* spawnSleep;
        const liveOwner = yield* spawnSleep;
        const orphan = yield* spawnSleep;
        const adopted = yield* spawnSleep;

        const dead = yield* RelayClientLedger.make({ stateDir, ownerPid: deadOwner.pid });
        yield* Effect.asVoid(dead.track(orphan.pid));
        const live = yield* RelayClientLedger.make({ stateDir, ownerPid: liveOwner.pid });
        yield* Effect.asVoid(live.track(adopted.pid));
        yield* deadOwner.kill;

        const restarted = yield* RelayClientLedger.make({ stateDir });
        yield* restarted.reapOrphans;

        expect(isAlive(orphan.pid)).toBe(false);
        expect(isAlive(adopted.pid)).toBe(true);
        expect(yield* entryNames(stateDir)).toEqual([`${adopted.pid}.json`]);
      }),
    ),
  );

  it.live("never signals a recycled pid and forgets the stale record", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
        const deadOwner = yield* spawnSleep;
        const unrelated = yield* spawnSleep;

        const dead = yield* RelayClientLedger.make({ stateDir, ownerPid: deadOwner.pid });
        yield* Effect.asVoid(dead.track(unrelated.pid));
        yield* deadOwner.kill;
        // The recorded client has exited and its pid now belongs to another process.
        const entryPath = path.join(stateDir, "relay-clients", `${unrelated.pid}.json`);
        const entry = JSON.parse(yield* fs.readFileString(entryPath));
        entry.client.startTime = "0";
        yield* fs.writeFileString(entryPath, JSON.stringify(entry));

        const restarted = yield* RelayClientLedger.make({ stateDir });
        yield* restarted.reapOrphans;

        expect(isAlive(unrelated.pid)).toBe(true);
        expect(yield* entryNames(stateDir)).toEqual([]);
      }),
    ),
  );
});
