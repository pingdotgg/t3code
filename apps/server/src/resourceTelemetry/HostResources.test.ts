import { assert, describe, expect, it } from "@effect/vitest";
import type * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostResources from "./HostResources.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

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
        NativeTelemetryClient.layerTest(),
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

const quiet: HostResources.MemoryPressureSample = {
  hostSome: 0,
  hostFull: 0,
  agentsFull: 0,
  darwinLevel: null,
};

describe("memory pressure level", () => {
  it("reads PSI averages", () => {
    const text =
      "some avg10=12.50 avg60=3.10 avg300=0.80 total=1\nfull avg10=4.00 avg60=1.00 avg300=0.10 total=1\n";
    expect(HostResources.psiAvg10(text, "some")).toBe(12.5);
    expect(HostResources.psiAvg10(text, "full")).toBe(4);
    expect(HostResources.psiAvg10("", "full")).toBeNull();
  });

  it("keeps small agents listed while rounding large ones coarsely", () => {
    const MiB = 1024 * 1024;
    expect(HostResources.roundAgentMemory(27_648_000)).toBe(28 * MiB);
    expect(HostResources.roundAgentMemory(3_200 * MiB + 1)).toBe(3_328 * MiB);
    expect(HostResources.roundAgentMemory(0)).toBe(0);
  });

  it("ranks agents by exact size, so close ones cannot push out the largest", () => {
    const MiB = 1024 * 1024;
    // All four round to 3,328 MiB; the largest comes last.
    const agents = [3_201, 3_202, 3_203, 3_204].map((size) => ({
      threadId: null,
      agent: `agent-${size}`,
      memoryBytes: size * MiB,
    }));
    expect(HostResources.heaviestAgents(agents).map((agent) => agent.agent)).toEqual([
      "agent-3204",
      "agent-3203",
      "agent-3202",
    ]);
  });

  it.each([
    { name: "a quiet host", previous: "none", sample: quiet, level: "none" },
    {
      name: "throttled agents, as in the 4 h freeze",
      previous: "none",
      sample: { ...quiet, hostSome: 30, hostFull: 3, agentsFull: 85 },
      level: "severe",
    },
    {
      name: "brief host stalls",
      previous: "none",
      sample: { ...quiet, hostSome: 12 },
      level: "elevated",
    },
    {
      name: "severe pressure easing but not gone",
      previous: "severe",
      sample: { ...quiet, hostFull: 5 },
      level: "severe",
    },
    {
      name: "severe pressure easing to stalls",
      previous: "severe",
      sample: { ...quiet, hostFull: 1 },
      level: "elevated",
    },
    {
      name: "elevated pressure fading below its entry threshold",
      previous: "elevated",
      sample: { ...quiet, hostSome: 5 },
      level: "elevated",
    },
    {
      name: "elevated pressure gone",
      previous: "elevated",
      sample: { ...quiet, hostSome: 1 },
      level: "none",
    },
    {
      name: "macOS critical pressure",
      previous: "none",
      sample: { hostSome: null, hostFull: null, agentsFull: null, darwinLevel: 4 },
      level: "severe",
    },
    {
      name: "a sample where nothing could be read",
      previous: "severe",
      sample: { hostSome: null, hostFull: null, agentsFull: null, darwinLevel: null },
      level: "severe",
    },
  ] as const)("reads $name as $level", ({ previous, sample, level }) => {
    expect(HostResources.nextMemoryPressureLevel(previous, sample)).toBe(level);
  });
});

const answersOnce = (level: number) => {
  let answered = false;
  return Effect.sync(() => {
    if (answered) return null;
    answered = true;
    return level;
  });
};

describe("HostResources memory pressure on macOS", () => {
  it.effect("reads the level from the running sidecar instead of spawning sysctl", () =>
    Effect.gen(function* () {
      const hostResources = yield* HostResources.HostResources;
      const [first] = yield* Stream.take(hostResources.memoryPressure, 1).pipe(Stream.runCollect);
      expect(first?.level).toBe("severe");
      const later = yield* Stream.take(hostResources.memoryPressure, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      // The sidecar stops answering: the warning must not outlive the pressure.
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(later)).map((pressure) => pressure.level)).toEqual([
        "severe",
        "none",
      ]);
    }).pipe(
      Effect.provide(
        HostResources.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NativeTelemetryClient.layerTest({
                memoryPressureLevel: answersOnce(4),
              }),
              Layer.succeed(HostProcess.Platform, "darwin"),
              FileSystem.layerNoop({}),
              // Under pressure a new process may never start, so sampling must not spawn one.
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("sampling spawned a process")),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
