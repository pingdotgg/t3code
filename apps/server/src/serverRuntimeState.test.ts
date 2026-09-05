// @effect-diagnostics nodeBuiltinImport:off - Exercise ownership with real OS processes and files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "./processRunner.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";
import { acquireServerOwnership, persistServerRuntimeState } from "./serverOwnership.ts";

const TestPlatformLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const encodeRuntimeState = Schema.encodeSync(
  Schema.fromJsonString(ServerRuntimeState.PersistedServerRuntimeState),
);

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      const { ownerId, ...restoredState } = Option.getOrThrow(restored);
      assert.isString(ownerId);
      assert.deepEqual(restoredState, state);
    }).pipe(Effect.provide(TestPlatformLayer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(TestPlatformLayer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("reports ownership acquisition failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ServerOwnershipError");
      if (error._tag === "ServerOwnershipError") {
        assert.equal(error.statePath, statePath);
        assert.instanceOf(error.cause, Error);
      }
    }).pipe(Effect.provide(TestPlatformLayer)),
  );
});

// The IPC barrier makes starts concurrent without sleeps. These are real OS locks
// in separate processes, not mocked filesystem or PID checks.
const ownerProcessSource = `
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { acquireServerOwnership } from "./src/serverOwnership.ts";
import * as ProcessRunner from "./src/processRunner.ts";
import * as Layer from "effect/Layer";
const TestPlatformLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
let stop;
const stopped = new Promise(resolve => { stop = resolve; });
process.on("message", message => {
  if (message === "stop") stop();
  if (message !== "start") return;
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owner = yield* acquireServerOwnership(process.argv[1]);
    yield* owner.publish({ version: 1, pid: process.pid, port: 45731,
      origin: "http://127.0.0.1:45731", startedAt: "2026-09-04T00:00:00.000Z" });
    process.send("acquired");
    yield* Effect.promise(() => stopped);
  })).pipe(Effect.provide(TestPlatformLayer))).then(
    () => process.exit(0),
    error => { process.send(error._tag ?? error.message); process.exit(1); },
  );
});
process.send("ready");
`;

async function spawnOwner(statePath: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", ownerProcessSource, statePath],
    {
      cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exit = NodeEvents.EventEmitter.once(child, "exit");
  await NodeEvents.EventEmitter.once(child, "message");
  return {
    child,
    start: async () => {
      const result = NodeEvents.EventEmitter.once(child, "message");
      child.send("start");
      return (await result)[0] as unknown;
    },
    stop: async (crash = false) => {
      if (child.exitCode === null && child.signalCode === null) {
        if (crash) child.kill("SIGKILL");
        else child.send("stop");
      }
      await exit;
    },
  };
}

it("serializes simultaneous process starts, including symlink aliases", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ownership-test-"));
  const stateDir = NodePath.join(root, "state");
  await NodeFSP.mkdir(stateDir);
  const alias = NodePath.join(root, "alias");
  await NodeFSP.symlink(stateDir, alias, "junction");
  const owners = await Promise.all([
    spawnOwner(NodePath.join(stateDir, "server-runtime.json")),
    spawnOwner(NodePath.join(alias, "server-runtime.json")),
  ]);
  try {
    const results = await Promise.all(owners.map((owner) => owner.start()));
    assert.sameMembers(results, ["acquired", "ServerAlreadyRunningError"]);
    const state = JSON.parse(
      await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
    );
    assert.equal(state.pid, owners[results.indexOf("acquired")]?.child.pid);
  } finally {
    await Promise.all(owners.map((owner) => owner.stop()));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps independent directories independent and recovers a crashed owner", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ownership-test-"));
  const firstPath = NodePath.join(root, "first", "server-runtime.json");
  const first = await spawnOwner(firstPath);
  const second = await spawnOwner(NodePath.join(root, "second", "server-runtime.json"));
  try {
    assert.deepEqual(await Promise.all([first.start(), second.start()]), ["acquired", "acquired"]);
    await first.stop(true);
    const replacement = await spawnOwner(firstPath);
    try {
      assert.equal(await replacement.start(), "acquired");
      const state = JSON.parse(await NodeFSP.readFile(firstPath, "utf8"));
      assert.equal(state.pid, replacement.child.pid);
    } finally {
      await replacement.stop();
    }
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("does not let old process cleanup delete a newer owner's record", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ownership-test-"));
  const statePath = NodePath.join(root, "server-runtime.json");
  const old = await spawnOwner(statePath);
  try {
    assert.equal(await old.start(), "acquired");
    const newer = {
      version: 1,
      pid: process.pid,
      ownerId: "new-owner",
      port: 4971,
      origin: "http://127.0.0.1:4971",
      startedAt: "2026-09-04T00:00:00.000Z",
    };
    // Recreate the incident's already-overwritten record before old shutdown.
    await NodeFSP.writeFile(statePath, JSON.stringify(newer));
    await old.stop();
    assert.deepEqual(JSON.parse(await NodeFSP.readFile(statePath, "utf8")), newer);
  } finally {
    await old.stop();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.live("refuses a live legacy owner and replaces stale ownership despite PID reuse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ownership-test-" });
    const statePath = NodePath.join(root, "server-runtime.json");
    const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 4971,
    });
    yield* fs.writeFileString(statePath, encodeRuntimeState(state));
    const error = yield* Effect.scoped(acquireServerOwnership(statePath)).pipe(Effect.flip);
    assert.equal(error._tag, "ServerAlreadyRunningError");
    yield* fs.writeFileString(
      statePath,
      encodeRuntimeState({ ...state, startedAt: "1970-01-01T00:00:00.000Z" }),
    );
    yield* Effect.scoped(acquireServerOwnership(statePath));
    yield* fs.writeFileString(
      statePath,
      encodeRuntimeState({
        ...state,
        ownerId: "crashed-owner",
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* acquireServerOwnership(statePath);
        yield* owner.publish(state);
      }),
    );
    assert.isFalse(yield* fs.exists(statePath));
    yield* fs.writeFileString(
      statePath,
      encodeRuntimeState({
        ...state,
        pid: 2147483647,
      }),
    );
    yield* Effect.scoped(acquireServerOwnership(statePath));
  }).pipe(Effect.provide(TestPlatformLayer)),
);

it.effect("rejects publication after ownership has been released", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-old-owner-test-" });
    const statePath = NodePath.join(root, "server-runtime.json");
    const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 45731,
    });
    const stalePublish = yield* Effect.scoped(
      Effect.gen(function* () {
        const old = yield* acquireServerOwnership(statePath);
        return old.publish({ ...state, port: 3773 });
      }),
    );
    const current = yield* acquireServerOwnership(statePath);
    yield* current.publish(state);
    const before = yield* fs.readFileString(statePath);
    const failure = yield* stalePublish.pipe(Effect.flip);
    assert.equal(failure._tag, "ServerOwnershipReleasedError");
    assert.equal(yield* fs.readFileString(statePath), before);
  }).pipe(Effect.provide(TestPlatformLayer)),
);
