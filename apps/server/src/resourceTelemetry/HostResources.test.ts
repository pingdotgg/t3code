import { assert, describe, expect, it } from "@effect/vitest";
import type * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostResources from "./HostResources.ts";

// An 8-CPU host; every cpus() call advances each CPU by 100 ms at `host.busy` utilization.
const host = vi.hoisted(() => ({ busy: 0, reads: 0 }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    totalmem: () => 4 * 1024 ** 3,
    cpus: () => {
      const elapsed = 100 * host.reads++;
      const times = {
        user: elapsed * host.busy,
        nice: 0,
        sys: 0,
        idle: elapsed * (1 - host.busy),
        irq: 0,
      };
      return Array.from({ length: 8 }, () => ({ model: "test", speed: 1, times }));
    },
  };
});
const setup = (busy = 0) => {
  host.busy = busy;
  host.reads = 0;
};

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const cgroup = "/sys/fs/cgroup/t3.slice/server.scope";
const unlimitedCgroup = {
  "/proc/self/cgroup": ["0::/t3.slice/server.scope\n"],
  "/proc/meminfo": [`MemTotal: ${4 * 1024 * 1024} kB\nMemAvailable: ${2 * 1024 * 1024} kB\n`],
  [`${cgroup}/cpu.max`]: ["max 100000\n"],
  [`${cgroup}/cpu.stat`]: ["usage_usec 5000000\n"],
  [`${cgroup}/memory.max`]: ["max\n"],
  [`${cgroup}/memory.current`]: [`${600 * MiB}\n`],
  [`${cgroup}/memory.stat`]: [`anon ${450 * MiB}\ninactive_file ${100 * MiB}\n`],
};

// Each path serves its values in order and repeats the last one.
const linuxHost = (files: Record<string, ReadonlyArray<string>>) => {
  const reads = new Map<string, number>();
  return HostResources.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) => {
            const values = files[path];
            if (!values) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              );
            }
            const index = reads.get(path) ?? 0;
            reads.set(path, index + 1);
            return Effect.succeed(values[Math.min(index, values.length - 1)]!);
          },
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("HostResources spawned on linux")),
        ),
      ),
    ),
  );
};

const read = Effect.gen(function* () {
  const host = yield* HostResources.HostResources;
  const fiber = yield* Effect.forkChild(host.read);
  yield* TestClock.adjust("200 millis");
  return yield* Fiber.join(fiber);
});

describe("parseDarwinRecommendedUpdates", () => {
  it.each([
    {
      name: "counts updates but not optional major OS upgrades",
      json: JSON.stringify([
        { "Display Name": "Safari", "Display Version": "27.2", Identifier: "Safari27.2TahoeAuto" },
        {
          "Display Name": "macOS Tahoe 26.7.2",
          "Display Version": "26.7.2",
          Identifier: "MSU_UPDATE_25G332_patch_26.7.2_minor",
          MobileSoftwareUpdate: true,
        },
        {
          "Display Name": "macOS 27.2",
          "Display Version": "27.2",
          Identifier: "MSU_UPDATE_26B123_patch_27.2_major",
          MobileSoftwareUpdate: true,
        },
        { "Display Version": "1.0", Identifier: "Unnamed" },
      ]),
      expected: { available: 3, names: ["Safari 27.2", "macOS Tahoe 26.7.2"] },
    },
    { name: "an empty list is zero updates", json: "[]", expected: { available: 0, names: [] } },
    { name: "plutil found no key", json: "", expected: undefined },
    { name: "a non-array value", json: '{"a":1}', expected: undefined },
  ])("$name", ({ json, expected }) => {
    expect(HostResources.parseDarwinRecommendedUpdates(json)).toEqual(expected);
  });
});

describe("parseUpdateNotifier", () => {
  it.each([
    {
      name: "Ubuntu 24.04 ignores ESM updates that cannot be applied",
      text: [
        "Expanded Security Maintenance for Applications is not enabled.",
        "",
        "136 updates can be applied immediately.",
        "To see these additional updates run: apt list --upgradable",
        "",
        "13 additional security updates can be applied with ESM Apps.",
      ].join("\n"),
      expected: { available: 136 },
    },
    {
      name: "standard security updates",
      text: "5 updates can be applied immediately.\n2 of these updates are standard security updates.\n",
      expected: { available: 5, security: 2 },
    },
    {
      name: "a single security update",
      text: "1 update can be applied immediately.\n1 of these updates is a standard security update.\n",
      expected: { available: 1, security: 1 },
    },
    {
      name: "pre-20.04 wording",
      text: "12 packages can be updated.\n3 updates are security updates.\n",
      expected: { available: 12, security: 3 },
    },
    { name: "no count", text: "", expected: undefined },
  ])("$name", ({ text, expected }) => {
    expect(HostResources.parseUpdateNotifier(text)).toEqual(expected);
  });
});

describe("HostResources.layer", () => {
  it.effect("reports the CPU quota and usage of the server's cgroup", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      // One CPU of quota, 150 ms of it used during the 200 ms sample.
      assert.strictEqual(snapshot.cpuCount, 1);
      assert.strictEqual(snapshot.cpuUtilization, 0.75);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["100000 100000\n"],
          [`${cgroup}/cpu.stat`]: [
            "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n",
            "usage_usec 5150000\nuser_usec 4100000\nsystem_usec 1050000\n",
          ],
        }),
      ),
    ),
  );

  it.effect("reports memory against the server cgroup's memory.max", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.totalMemoryBytes, GiB);
      // 600 MiB charged, of which 100 MiB is reclaimable page cache.
      assert.strictEqual(snapshot.availableMemoryBytes, GiB - 500 * MiB);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/memory.max`]: [`${GiB}\n`],
        }),
      ),
    ),
  );

  it.effect("counts a busy host against an idle, quota-limited server cgroup", () =>
    Effect.gen(function* () {
      // Agents in sibling cgroups keep the host 90% busy; the server's own cgroup is idle.
      setup(0.9);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 2);
      // Only 0.8 of 8 host CPUs are free, which is 60% of the 2-CPU quota in use.
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.6, 1e-9);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["200000 100000\n"],
        }),
      ),
    ),
  );

  it.effect("samples the CPUs the server is pinned to by id, not by os.cpus() index", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 1);
      assert.strictEqual(snapshot.cpuUtilization, 1);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          "/proc/self/status": ["Name:\tnode\nCpus_allowed_list:\t4\n"],
          // CPU 1 is offline; the server's CPU 4 is saturated, everything else is idle.
          "/proc/stat": [0, 100].map((elapsed) =>
            [0, 2, 3, 4, 5, 6, 7]
              .map((id) =>
                id === 4
                  ? `cpu${id} ${elapsed} 0 0 0 0 0 0 0`
                  : `cpu${id} 0 0 0 ${elapsed} 0 0 0 0`,
              )
              .join("\n"),
          ),
        }),
      ),
    ),
  );

  it.effect("keeps host memory when the cgroup's memory.current is unreadable", () =>
    Effect.gen(function* () {
      setup();
      const snapshot = yield* read;

      assert.strictEqual(snapshot.totalMemoryBytes, 4 * GiB);
      assert.strictEqual(snapshot.availableMemoryBytes, 2 * GiB);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/memory.max`]: [`${GiB}\n`],
          [`${cgroup}/memory.current`]: [""],
        }),
      ),
    ),
  );

  it.effect("keeps host values when the cgroup has no limits", () =>
    Effect.gen(function* () {
      setup(0.25);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 8);
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.25, 1e-9);
      assert.strictEqual(snapshot.availableMemoryBytes, 2 * GiB);
    }).pipe(Effect.provide(linuxHost(unlimitedCgroup))),
  );

  it.effect("falls back to host load when the cgroup's cpu.stat is unreadable", () =>
    Effect.gen(function* () {
      setup(0.9);
      const snapshot = yield* read;

      assert.strictEqual(snapshot.cpuCount, 2);
      assert.closeTo(snapshot.cpuUtilization ?? Number.NaN, 0.6, 1e-9);
    }).pipe(
      Effect.provide(
        linuxHost({
          ...unlimitedCgroup,
          [`${cgroup}/cpu.max`]: ["200000 100000\n"],
          [`${cgroup}/cpu.stat`]: [""],
        }),
      ),
    ),
  );
});
