import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  compareExactVersions,
  decodeServiceState,
  Launcher,
  readServiceState,
  writeServiceState,
} from "./serviceLauncher.ts";

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.throws(() =>
    decodeServiceState({
      schemaVersion: 1,
      launcherProtocol: 1,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        status: "pending",
        requestedAt: "2026-08-01T00:00:00.000Z",
      },
    }),
  );

  assert.throws(() =>
    decodeServiceState({
      schemaVersion: 1,
      launcherProtocol: 1,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        status: "pending",
        requestedAt: "2026-08-01T00:00:00.000Z",
      },
    }),
  );
});

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect("durably replaces and strictly reads one state document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-test-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const state = {
        schemaVersion: 1,
        launcherProtocol: 1,
        activeVersion: "0.0.31",
      } as const;

      yield* Effect.promise(() => writeServiceState(statePath, state));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);
    }),
  );

  it.effect("commits only after the trial reports prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-flow-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.trial) {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") process.exit(0);
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", fromVersion: "1.0.0", targetVersion: "1.1.0" });
  process.on("message", (message) => {
    if (message.type === "update-accepted") process.exit(75);
  });
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        const versionDir = path.join(root, "runtime", "versions", version);
        const entryPath = path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fs.writeFileString(entryPath, childSource);
        yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${version}\n`);
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          schemaVersion: 1,
          launcherProtocol: 1,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
    }),
  );

  it.effect("rolls back a trial that reports the wrong update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.trial) {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  process.send({ type: "request-update", fromVersion: "1.0.0", targetVersion: "1.1.0" });
  process.on("message", (message) => {
    if (message.type === "update-accepted") process.exit(75);
  });
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        const versionDir = path.join(root, "runtime", "versions", version);
        const entryPath = path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fs.writeFileString(entryPath, childSource);
        yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${version}\n`);
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          schemaVersion: 1,
          launcherProtocol: 1,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
    }),
  );
});
