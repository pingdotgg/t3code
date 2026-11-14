import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ResourceMonitorHostDisk, ResourceMonitorHostSystemEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostStorage from "./HostStorage.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

const GiB = 1024 ** 3;
const disk = (overrides: Partial<ResourceMonitorHostDisk>): ResourceMonitorHostDisk => ({
  mountPoint: "/",
  name: "disk",
  fileSystem: "ext4",
  totalBytes: 100 * GiB,
  availableBytes: 40 * GiB,
  removable: false,
  readOnly: false,
  ...overrides,
});

describe("selectHostVolumes", () => {
  it("collapses the APFS system snapshot into its writable Data volume", () => {
    const volumes = HostStorage.selectHostVolumes(
      [
        disk({ mountPoint: "/", name: "Macintosh HD", fileSystem: "apfs", readOnly: true }),
        disk({ mountPoint: "/System/Volumes/Data", name: "Macintosh HD", fileSystem: "apfs" }),
        disk({ mountPoint: "/System/Volumes/VM", name: "Macintosh HD - VM", fileSystem: "apfs" }),
        disk({
          mountPoint: "/private/var/run/com.apple.security.cryptexd/mnt/sim",
          name: "Simulator",
          fileSystem: "apfs",
          totalBytes: 18 * GiB,
        }),
      ],
      [
        { role: "t3Home", path: "/Users/me/.t3" },
        { role: "worktrees", path: "/Users/me/.t3/worktrees" },
      ],
      "darwin",
    );

    assert.deepStrictEqual(volumes, [
      {
        mountPoint: "/System/Volumes/Data",
        name: "Macintosh HD",
        fileSystem: "apfs",
        totalBytes: 100 * GiB,
        availableBytes: 40 * GiB,
        roles: ["t3Home", "worktrees"],
      },
    ]);
  });

  it("assigns each role to the deepest mount and drops pseudo filesystems", () => {
    const volumes = HostStorage.selectHostVolumes(
      [
        disk({ mountPoint: "/" }),
        disk({ mountPoint: "/home", name: "home", totalBytes: 500 * GiB, availableBytes: GiB }),
        disk({ mountPoint: "/dev/shm", name: "tmpfs", fileSystem: "tmpfs" }),
        disk({ mountPoint: "/snap/core/1", name: "core", fileSystem: "squashfs", readOnly: true }),
        disk({ mountPoint: "/boot/efi", name: "efi", fileSystem: "vfat", totalBytes: GiB }),
        disk({ mountPoint: "/mnt/data", name: "data", totalBytes: 2_000 * GiB }),
      ],
      [
        { role: "t3Home", path: "/home/me/.t3" },
        { role: "worktrees", path: "/srv/worktrees" },
      ],
      "linux",
    );

    assert.deepStrictEqual(
      volumes.map((volume) => [volume.mountPoint, volume.roles]),
      [
        ["/", ["worktrees"]],
        ["/home", ["t3Home"]],
        ["/mnt/data", []],
      ],
    );
  });

  it("keeps a read-only or pseudo volume that holds T3 data", () => {
    const volumes = HostStorage.selectHostVolumes(
      [disk({ mountPoint: "/", fileSystem: "overlay" })],
      [{ role: "t3Home", path: "/root/.t3" }],
      "linux",
    );

    assert.deepStrictEqual(
      volumes.map((volume) => volume.roles),
      [["t3Home"]],
    );
  });

  it("matches Windows drives case-insensitively without prefix collisions", () => {
    const volumes = HostStorage.selectHostVolumes(
      [
        disk({ mountPoint: "C:\\", name: "Windows", fileSystem: "NTFS" }),
        disk({ mountPoint: "D:\\", name: "Data", fileSystem: "NTFS", totalBytes: 200 * GiB }),
      ],
      [
        { role: "t3Home", path: "c:\\Users\\me\\.t3" },
        { role: "worktrees", path: "D:\\worktrees" },
      ],
      "win32",
    );

    assert.deepStrictEqual(
      volumes.map((volume) => [volume.mountPoint, volume.roles]),
      [
        ["C:\\", ["t3Home"]],
        ["D:\\", ["worktrees"]],
      ],
    );
  });
});

describe("hostGpus", () => {
  it("converts percent to a clamped share and keeps absent fields absent", () => {
    assert.deepStrictEqual(
      HostStorage.hostGpus({
        gpus: [
          { name: "Apple M3 Max", utilizationPercent: 9, memoryUsedBytes: GiB },
          { name: "Overdriven", utilizationPercent: 250, memoryTotalBytes: 8 * GiB },
          { name: "Idle", utilizationPercent: Number.NaN },
        ],
      }),
      {
        gpus: [
          { name: "Apple M3 Max", utilization: 0.09, memoryUsedBytes: GiB },
          { name: "Overdriven", utilization: 1, memoryTotalBytes: 8 * GiB },
          { name: "Idle" },
        ],
      },
    );
  });

  it("explains an empty list instead of implying no GPU", () => {
    assert.deepStrictEqual(
      HostStorage.hostGpus({ gpus: [], gpuUnavailableReason: "No GPU found" }),
      {
        gpus: [],
        unavailableReason: "No GPU found",
      },
    );
    // A monitor from before GPU support omits the field entirely.
    assert.match(HostStorage.hostGpus({}).unavailableReason ?? "", /does not report GPUs/);
  });
});

const hostSystem = (
  disks: ReadonlyArray<ResourceMonitorHostDisk>,
): ResourceMonitorHostSystemEvent => ({
  version: 3,
  type: "hostSystem",
  requestId: "request",
  disks: [...disks],
  swapTotalBytes: 4 * GiB,
  swapUsedBytes: GiB,
});

const storageLayer = (
  native: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>,
  baseDir: string | { readonly prefix: string } = { prefix: "t3-host-storage-" },
) =>
  HostStorage.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NativeTelemetryClient.layerTest(native),
        ServerConfig.layerTest(process.cwd(), baseDir),
        ServerSettings.layerTest(),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("HostStorage.layer", () => {
  it.effect("reports native volumes with T3 roles and swap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-storage-" }),
      );
      const reading = yield* Effect.gen(function* () {
        return yield* (yield* HostStorage.HostStorage).read;
      }).pipe(
        Effect.provide(
          storageLayer(
            {
              hostSystem: Effect.succeed(
                hostSystem([
                  disk({ mountPoint: "/" }),
                  disk({ mountPoint: baseDir, name: "t3", totalBytes: 10 * GiB }),
                ]),
              ),
            },
            baseDir,
          ),
        ),
      );

      assert.deepStrictEqual(
        reading.storage.volumes.map((volume) => [volume.name, volume.roles]),
        [
          ["t3", ["t3Home", "worktrees"]],
          ["disk", []],
        ],
      );
      assert.notProperty(reading.storage, "unavailableReason");
      assert.deepStrictEqual(reading.swap, { totalBytes: 4 * GiB, usedBytes: GiB });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to statfs for T3 volumes and says why when native is unavailable", () =>
    Effect.gen(function* () {
      const storage = yield* HostStorage.HostStorage;
      const reading = yield* storage.read;

      // The T3 home and its worktrees share one device in a temp directory.
      assert.strictEqual(reading.storage.volumes.length, 1);
      assert.deepStrictEqual(reading.storage.volumes[0]?.roles, ["t3Home", "worktrees"]);
      assert.isAbove(reading.storage.volumes[0]?.totalBytes ?? 0, 0);
      assert.match(reading.storage.unavailableReason ?? "", /host system/);
      assert.notProperty(reading, "swap");
      assert.deepStrictEqual(reading.gpu.gpus, []);
      assert.match(reading.gpu.unavailableReason ?? "", /GPUs are not shown/);
    }).pipe(Effect.provide(storageLayer({}))),
  );

  it.effect("shares one native read and serves the last reading while a refresh stalls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const stalledStarted = yield* Deferred.make<void>();
      const program = Effect.gen(function* () {
        const storage = yield* HostStorage.HostStorage;
        const first = yield* storage.read;
        // Past the freshness window, the next refresh stalls on a hung mount.
        yield* TestClock.adjust("20 seconds");
        const stalled = yield* Effect.forkChild(
          Effect.all([storage.read, storage.read], { concurrency: 2 }),
        );
        yield* Deferred.await(stalledStarted);
        yield* TestClock.adjust("3 seconds");
        const [second, third] = yield* Fiber.join(stalled);
        return { first, second, third };
      });
      const { first, second, third } = yield* program.pipe(
        Effect.provide(
          storageLayer({
            hostSystem: Ref.getAndUpdate(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 0
                  ? Effect.void
                  : Deferred.succeed(stalledStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
              ),
              Effect.as(hostSystem([disk({ mountPoint: "/" })])),
            ),
          }),
        ),
      );

      assert.strictEqual(yield* Ref.get(calls), 2);
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(third, first);
    }),
  );
});
