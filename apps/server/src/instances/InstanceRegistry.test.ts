import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type InstanceRecord,
  type InstanceRegistryShape,
  isPidAlive,
  make,
} from "./InstanceRegistry.ts";

const makeRecord = (overrides: Partial<InstanceRecord> = {}): InstanceRecord => ({
  instanceId: "instance-1",
  name: null,
  pid: process.pid,
  port: 51234,
  host: "127.0.0.1",
  baseDir: "/tmp/t3-instance-1",
  cwd: "/tmp/project",
  startedAt: "2026-06-07T00:00:00.000Z",
  schemaVersion: 1,
  ...overrides,
});

// A pid that is essentially guaranteed not to be running.
const DEAD_PID = 2_147_483_646;

it.layer(NodeServices.layer)("InstanceRegistry", (it) => {
  const withRegistry = <A, E, R>(
    run: (registry: InstanceRegistryShape, registryDir: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-instance-registry-" });
      const registry = yield* make(registryDir);
      return yield* run(registry, registryDir);
    });

  it.effect("announce then list returns the live record", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const record = makeRecord();
        yield* registry.announce(record);

        const listed = yield* registry.list();
        assert.equal(listed.length, 1);
        assert.deepEqual(listed[0], record);
      }),
    ),
  );

  it.effect("withdraw removes the instance from list", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const record = makeRecord();
        yield* registry.announce(record);
        yield* registry.withdraw(record.instanceId);

        const listed = yield* registry.list();
        assert.equal(listed.length, 0);
      }),
    ),
  );

  it.effect("list prunes lock files whose pid is dead", () =>
    withRegistry((registry, registryDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const alive = makeRecord({ instanceId: "alive", pid: process.pid });
        const dead = makeRecord({ instanceId: "dead", pid: DEAD_PID });
        yield* registry.announce(alive);
        // Write the dead record directly so announce's encoding is not relied on.
        yield* fs.writeFileString(
          path.join(registryDir, "dead.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify(dead)}\n`,
        );

        const listed = yield* registry.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.instanceId, "alive");

        // The stale lock file must have been removed from disk.
        const remaining = yield* fs.readDirectory(registryDir);
        assert.isFalse(remaining.includes("dead.json"));
      }),
    ),
  );

  it.effect("list returns empty when the registry directory is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-instance-registry-absent-" });
      const registry = yield* make(path.join(parent, "does-not-exist"));

      const listed = yield* registry.list();
      assert.equal(listed.length, 0);
    }),
  );

  it.effect("list ignores corrupt lock files and removes them", () =>
    withRegistry((registry, registryDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(registryDir, "corrupt.json"), "not valid json");

        const listed = yield* registry.list();
        assert.equal(listed.length, 0);

        const remaining = yield* fs.readDirectory(registryDir);
        assert.isFalse(remaining.includes("corrupt.json"));
      }),
    ),
  );
});

describe("isPidAlive", () => {
  it("treats the current process as alive and a sentinel pid as dead", () => {
    assert.isTrue(isPidAlive(process.pid));
    assert.isFalse(isPidAlive(DEAD_PID));
    assert.isFalse(isPidAlive(0));
    assert.isFalse(isPidAlive(-1));
  });
});
