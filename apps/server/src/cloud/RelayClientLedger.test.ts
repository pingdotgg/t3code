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

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const spawnProcess = Effect.acquireRelease(
  Effect.gen(function* () {
    const child = NodeChildProcess.spawn("sleep", ["600"], { stdio: "ignore" });
    const exited = yield* Deferred.make<NodeJS.Signals | null>();
    child.once("exit", (_code, signal) => Deferred.doneUnsafe(exited, Effect.succeed(signal)));
    const pid = child.pid;
    if (pid === undefined) return yield* Effect.die("spawn failed");
    return { pid, exited: Deferred.await(exited) };
  }),
  ({ pid }) =>
    Effect.sync(() => {
      if (processExists(pid)) process.kill(pid, "SIGKILL");
    }),
);

const recordFromDeadServer = (stateDir: string, client: { readonly pid: number }) =>
  Effect.gen(function* () {
    const previousServer = yield* spawnProcess;
    const previousLedger = yield* RelayClientLedger.make({
      stateDir,
      ownerPid: previousServer.pid,
    });
    yield* Effect.asVoid(previousLedger.track({ pid: client.pid }));
    process.kill(previousServer.pid, "SIGKILL");
    yield* previousServer.exited;
  });

const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

describe.each(observedPlatforms)("RelayClientLedger observing as %s", (platform) => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(NodeServices.layer),
    );

  it.live("records a started relay client until it is forgotten", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const client = yield* spawnProcess;
      const ledger = yield* RelayClientLedger.make({ stateDir });

      const forget = yield* ledger.track({ pid: client.pid });

      const entryPath = path.join(stateDir, "relay-clients", `${client.pid}.json`);
      expect(yield* fs.readDirectory(path.join(stateDir, "relay-clients"))).toEqual([
        `${client.pid}.json`,
      ]);
      expect(JSON.parse(yield* fs.readFileString(entryPath))).toMatchObject({
        version: 1,
        pid: client.pid,
        command: "sleep 600",
        stateDir,
        owner: { pid: process.pid },
      });

      yield* forget;
      expect(yield* fs.readDirectory(path.join(stateDir, "relay-clients"))).toEqual([]);
      expect(processExists(client.pid)).toBe(true);
    }).pipe(provideHost),
  );

  it.live("stops a relay client left by a server that died", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const orphan = yield* spawnProcess;
      yield* recordFromDeadServer(stateDir, orphan);
      expect(yield* fs.readDirectory(path.join(stateDir, "relay-clients"))).toHaveLength(1);

      const restarted = yield* RelayClientLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* orphan.exited).toBe("SIGTERM");
      expect(processExists(orphan.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "relay-clients"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("leaves the relay client of a running server alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const running = yield* RelayClientLedger.make({ stateDir });
      const client = yield* spawnProcess;
      const forget = yield* running.track({ pid: client.pid });

      const other = yield* RelayClientLedger.make({ stateDir });
      yield* other.reapOrphans;

      expect(processExists(client.pid)).toBe(true);
      expect(yield* fs.readDirectory(path.join(stateDir, "relay-clients"))).toEqual([
        `${client.pid}.json`,
      ]);
      yield* forget;
    }).pipe(provideHost),
  );

  it.live.each([
    { field: "start time", recorded: /"startTime":"[^"]+"/, replacement: '"startTime":"1"' },
    {
      field: "command line",
      recorded: /"command":"[^"]+"/,
      replacement: '"command":"cloudflared tunnel run"',
    },
  ])("leaves a recycled pid alone when its $field does not match", ({ recorded, replacement }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const unrelated = yield* spawnProcess;
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "relay-clients", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      expect(entry).toMatch(recorded);
      yield* fs.writeFileString(entryPath, entry.replace(recorded, replacement));

      const restarted = yield* RelayClientLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(processExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves a relay client recorded for another state directory alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const otherStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-ledger-" });
      const client = yield* spawnProcess;
      yield* recordFromDeadServer(otherStateDir, client);
      const entryName = `${client.pid}.json`;
      const otherEntryPath = path.join(otherStateDir, "relay-clients", entryName);
      const entryPath = path.join(stateDir, "relay-clients", entryName);
      // A state directory copied from another install still names its origin.
      yield* fs.makeDirectory(path.join(stateDir, "relay-clients"), { recursive: true });
      yield* fs.writeFileString(entryPath, yield* fs.readFileString(otherEntryPath));

      const restarted = yield* RelayClientLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(processExists(client.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
      expect(yield* fs.exists(otherEntryPath)).toBe(true);
    }).pipe(provideHost),
  );
});
