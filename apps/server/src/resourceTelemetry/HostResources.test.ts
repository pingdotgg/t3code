import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, expect, it } from "@effect/vitest";
import type * as NodeOS from "node:os";
import * as AgentScope from "@t3tools/shared/AgentScope";
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

import * as Config from "../config.ts";
import * as HostResources from "./HostResources.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

// An 8-CPU host; every cpus() call advances each CPU by 100 ms at `host.busy` utilization.
const host = vi.hoisted(() => ({
  busy: 0,
  reads: 0,
  load: 0,
  disk: { bavail: 512 * 1024 * 1024, blocks: 1024 * 1024 * 1024, bsize: 512 },
  worktreesDisk: null as { bavail: number; blocks: number; bsize: number } | null,
  hangStatfs: false,
  statfsCalls: 0,
  gvfsShares: [] as Array<string>,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  statfs: (path: string) => {
    host.statfsCalls++;
    if (host.hangStatfs) return new Promise(() => {});
    const disk = path.endsWith("/worktrees") && host.worktreesDisk ? host.worktreesDisk : host.disk;
    return Promise.resolve({ ...disk });
  },
  readdir: () => Promise.resolve(host.gvfsShares),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    totalmem: () => 4 * 1024 ** 3,
    loadavg: () => [host.load, host.load, host.load],
    availableParallelism: () => 8,
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
  host.load = 0;
  host.disk = { bavail: 512 * 1024 * 1024, blocks: 1024 * 1024 * 1024, bsize: 512 };
  host.worktreesDisk = null;
  host.hangStatfs = false;
  host.statfsCalls = 0;
  host.gvfsShares = [];
};

afterEach(() => {
  host.hangStatfs = false;
});

const layerConfig = Config.layerTest(process.cwd(), { prefix: "host-resources-" }).pipe(
  Layer.provide(NodeServices.layer),
);

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
          readDirectory: (path) =>
            Effect.succeed([
              ...new Set(
                Object.keys(files)
                  .filter((file) => file.startsWith(`${path}/`))
                  .map((file) => file.slice(path.length + 1).split("/")[0]!),
              ),
            ]),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        NativeTelemetryClient.layerTest(),
        layerConfig,
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

const quiet: HostResources.PressureSample = {
  memorySome: 0,
  memoryFull: 0,
  agentsMemoryFull: 0,
  darwinMemoryLevel: null,
  cpuSome: 0,
  ioFull: 0,
  blockBusy: null,
  loadPerCpu: null,
  diskFreeBytes: 500 * GiB,
  diskTotalBytes: 1000 * GiB,
};
const unread: HostResources.PressureSample = {
  memorySome: null,
  memoryFull: null,
  agentsMemoryFull: null,
  darwinMemoryLevel: null,
  cpuSome: null,
  ioFull: null,
  blockBusy: null,
  loadPerCpu: null,
  diskFreeBytes: null,
  diskTotalBytes: null,
};
const levels = (overrides: Partial<HostResources.PressureLevels>) => ({
  ...HostResources.CALM,
  ...overrides,
});

describe("pressure levels", () => {
  it("reads PSI averages", () => {
    const text =
      "some avg10=12.50 avg60=3.10 avg300=0.80 total=1\nfull avg10=4.00 avg60=1.00 avg300=0.10 total=1\n";
    expect(HostResources.psiAverage(text, "some", "avg10")).toBe(12.5);
    expect(HostResources.psiAverage(text, "full", "avg60")).toBe(1);
    expect(HostResources.psiAverage("", "full", "avg10")).toBeNull();
  });

  it("bounds storage stalls by the time block devices had I/O in flight", () => {
    const disk = (name: string, inFlight: number, ioTicks: number) =>
      `   8       0 ${name} 5 0 9 1 7 0 3 2 ${inFlight} ${ioTicks} 4 0 0 0 0 0 0\n`;
    const devices = new Set(["sda", "sdb"]);
    const reading = (at: number, stats: string) => ({
      at,
      ...HostResources.blockDeviceActivity(stats, devices)!,
    });
    // A partition repeats its device's time.
    expect(
      HostResources.blockDeviceActivity(disk("sda", 0, 500) + disk("sda1", 0, 500), devices),
    ).toEqual({ busyMs: 500, inFlight: false });
    expect(HostResources.blockDeviceActivity("", devices)).toBeNull();
    // Two disks that stalled at different times add up.
    expect(
      HostResources.blockBusyPercent([
        reading(0, disk("sda", 0, 0) + disk("sdb", 0, 0)),
        reading(30_000, disk("sda", 0, 12_000) + disk("sdb", 0, 0)),
        reading(60_000, disk("sda", 0, 12_000) + disk("sdb", 0, 12_000)),
      ]),
    ).toBe(40);
    // A hung request never completes, so it never reaches io_ticks.
    expect(
      HostResources.blockBusyPercent([
        reading(0, disk("sda", 1, 700)),
        reading(5_000, disk("sda", 1, 700)),
      ]),
    ).toBe(100);
    expect(
      HostResources.blockBusyPercent([
        { at: 0, busyMs: null, inFlight: false },
        reading(5_000, disk("sda", 0, 700)),
      ]),
    ).toBeNull();
  });

  it("tells mounts that stall off block devices from local ones", () => {
    const local =
      "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n" +
      "23 22 0:21 / /proc rw,nosuid shared:5 - proc proc rw\n" +
      "24 22 0:27 /@home /home rw shared:9 - btrfs /dev/mapper/root rw,subvol=/@home\n" +
      "30 22 0:59 / /run/user/1000/doc rw shared:498 - fuse.portal portal rw,user_id=1000\n";
    const appImage =
      "50 22 0:60 / /tmp/.mount_T3-Codabc123 ro - fuse.T3-Code-x86_64.AppImage T3-Code-x86_64.AppImage ro\n";
    const read = (mounts: string, appDir?: string) =>
      HostResources.mountsOffBlockDevices(mounts, appDir);
    expect(read(local)).toEqual({ nfs: false, gvfs: [], unknown: false });
    expect(read(`${local}40 22 0:61 / /mnt/work rw shared:60 - nfs4 nas:/work rw,hard\n`)).toEqual({
      nfs: true,
      gvfs: [],
      unknown: false,
    });
    expect(
      read(`${local}31 22 0:58 / /run/user/1000/gvfs rw - fuse.gvfsd-fuse gvfsd-fuse rw\n`),
    ).toEqual({ nfs: false, gvfs: ["/run/user/1000/gvfs"], unknown: false });
    // The server's own AppImage is a local file; another program's FUSE mount is not known to be.
    expect(read(local + appImage, "/tmp/.mount_T3-Codabc123/").unknown).toBe(false);
    for (const mount of [
      appImage,
      "41 22 0:62 / /mnt/remote rw - fuse.sshfs user@host:/srv rw,user_id=1000\n",
      "42 22 0:63 / /mnt/new rw - some-new-fs none rw\n",
    ]) {
      expect(read(local + mount).unknown).toBe(true);
    }
    // An unreadable table rules nothing out.
    expect(read("").unknown).toBe(true);
  });

  it("keeps small agents listed while rounding large ones coarsely", () => {
    expect(HostResources.roundCoarsely(27_648_000)).toBe(28 * MiB);
    expect(HostResources.roundCoarsely(3_200 * MiB + 1)).toBe(3_328 * MiB);
    expect(HostResources.roundCoarsely(0)).toBe(0);
  });

  it("ranks agents by exact size, so close ones cannot push out the largest", () => {
    // All four round to 3,328 MiB; the largest comes last.
    const agents = [3_201, 3_202, 3_203, 3_204].map((size) => ({
      threadId: null,
      agent: `agent-${size}`,
      memoryBytes: size * MiB,
      cpuCores: 5_000 - size,
    }));
    expect(HostResources.heaviestAgents(agents, "memory").map((agent) => agent.agent)).toEqual([
      "agent-3204",
      "agent-3203",
      "agent-3202",
    ]);
    expect(HostResources.heaviestAgents(agents, "cpu").map((agent) => agent.agent)).toEqual([
      "agent-3201",
      "agent-3202",
      "agent-3203",
    ]);
  });

  it.each([
    { name: "a quiet host", previous: {}, sample: quiet, expected: {} },
    {
      name: "throttled agents, as in the 4 h freeze",
      previous: {},
      sample: { ...quiet, memorySome: 30, memoryFull: 3, agentsMemoryFull: 85 },
      expected: { memory: "severe" },
    },
    {
      name: "brief memory stalls",
      previous: {},
      sample: { ...quiet, memorySome: 12 },
      expected: { memory: "elevated" },
    },
    {
      name: "severe memory pressure easing but not gone",
      previous: { memory: "severe" },
      sample: { ...quiet, memoryFull: 5 },
      expected: { memory: "severe" },
    },
    {
      name: "severe memory pressure easing to stalls",
      previous: { memory: "severe" },
      sample: { ...quiet, memoryFull: 1 },
      expected: { memory: "elevated" },
    },
    {
      name: "elevated memory pressure fading below its entry threshold",
      previous: { memory: "elevated" },
      sample: { ...quiet, memorySome: 5 },
      expected: { memory: "elevated" },
    },
    {
      name: "elevated memory pressure gone",
      previous: { memory: "elevated" },
      sample: { ...quiet, memorySome: 1 },
      expected: {},
    },
    {
      name: "macOS critical memory pressure",
      previous: {},
      sample: { ...unread, darwinMemoryLevel: 4 },
      expected: { memory: "severe" },
    },
    {
      name: "a busy CPU whose work rarely waits",
      previous: {},
      sample: { ...quiet, cpuSome: 10 },
      expected: {},
    },
    {
      name: "work waiting for a CPU most of the last minute",
      previous: {},
      sample: { ...quiet, cpuSome: 70 },
      expected: { cpu: "severe" },
    },
    {
      name: "a load average three times the CPUs, without PSI",
      previous: {},
      sample: { ...unread, loadPerCpu: 3.2 },
      expected: { cpu: "severe" },
    },
    {
      name: "storage stalling every task",
      previous: {},
      sample: { ...quiet, ioFull: 12 },
      expected: { io: "elevated" },
    },
    {
      name: "io PSI with no storage at work, such as a terminal idling in io_uring",
      previous: {},
      sample: { ...quiet, ioFull: 77, blockBusy: 1.5 },
      expected: {},
    },
    {
      name: "io PSI that outlasts the storage stall behind it",
      previous: { io: "severe" },
      sample: { ...quiet, ioFull: 40, blockBusy: 1 },
      expected: {},
    },
    {
      name: "a disk under 20 GiB free",
      previous: {},
      sample: { ...quiet, diskFreeBytes: 15 * GiB },
      expected: { disk: "elevated" },
    },
    {
      name: "a disk under 5 GiB free",
      previous: {},
      sample: { ...quiet, diskFreeBytes: 4 * GiB },
      expected: { disk: "severe" },
    },
    {
      name: "a nearly full disk just back above its threshold",
      previous: { disk: "severe" },
      sample: { ...quiet, diskFreeBytes: 6 * GiB },
      expected: { disk: "severe" },
    },
    {
      name: "a small disk judged by its share free",
      previous: {},
      sample: { ...quiet, diskFreeBytes: 12 * GiB, diskTotalBytes: 100 * GiB },
      expected: { disk: "elevated" },
    },
    {
      name: "a sample where nothing could be read",
      previous: { memory: "severe", cpu: "elevated", io: "elevated", disk: "severe" },
      sample: unread,
      expected: { memory: "severe", cpu: "elevated", io: "elevated", disk: "severe" },
    },
  ] as const)("reads $name", ({ previous, sample, expected }) => {
    expect(HostResources.nextPressureLevels(levels(previous), sample)).toEqual(levels(expected));
  });
});

describe("HostResources pressure on Linux", () => {
  const scope = "/agents/owned/t3code-claude-0123abcd.scope";
  const pressured = (overrides: Record<string, ReadonlyArray<string>>) =>
    linuxHost({
      "/proc/pressure/memory": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
      "/proc/pressure/cpu": ["some avg10=90.00 avg60=75.00\nfull avg10=0.00 avg60=0.00\n"],
      "/proc/pressure/io": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
      "/sys/fs/cgroup/agents/memory.pressure": ["some avg10=0.00\nfull avg10=0.00\n"],
      [`/sys/fs/cgroup${scope}/memory.current`]: [`${900 * MiB}\n`],
      [`/sys/fs/cgroup${scope}/cpu.stat`]: ["usage_usec 0\n", "usage_usec 15000000\n"],
      ...overrides,
    }).pipe(
      Layer.provide(
        Layer.succeed(AgentScope.AgentScope, {
          ...AgentScope.AgentScope.defaultValue(),
          controlGroups: Effect.succeed({
            slice: "/agents",
            scopes: [{ path: scope, threadId: "thread-1", agent: "claude" }],
          }),
        }),
      ),
    );

  it.effect("names the agents using the most CPU while work waits for one", () =>
    Effect.gen(function* () {
      setup();
      const hostResources = yield* HostResources.HostResources;
      const samples = yield* Stream.take(hostResources.pressure, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("5 seconds");
      const [first, second] = yield* Fiber.join(samples);
      expect(first).toMatchObject({ cpu: "severe", memory: "none", disk: "none" });
      // One reading cannot tell CPU use; the next one, 15 s of CPU in 5 s, can.
      expect(first?.heaviestAgents).toEqual([]);
      expect(second?.heaviestAgents).toEqual([
        { threadId: "thread-1", agent: "claude", memoryBytes: 960 * MiB, cpuCores: 3 },
      ]);
    }).pipe(Effect.provide(pressured({}))),
  );

  const calmCpu = "some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n";
  const ioStalled = "some avg10=45.00 avg60=42.00\nfull avg10=44.00 avg60=40.00\n";
  const diskstats = (ioTicks: number) =>
    ` 259       0 nvme0n1 5 0 9 1 7 0 3 2 0 ${ioTicks} 4 0 0 0 0 0 0\n` +
    ` 259       2 nvme0n1p2 5 0 9 1 7 0 3 2 0 ${ioTicks} 4 0 0 0 0 0 0\n`;
  const localMounts =
    "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n" +
    "23 22 0:21 / /proc rw,nosuid shared:5 - proc proc rw\n" +
    "31 22 0:58 / /run/user/1000/gvfs rw - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000\n";
  const ioPressured = (
    ioTicks: ReadonlyArray<number>,
    network: Record<string, ReadonlyArray<string>> = {},
  ) =>
    pressured({
      "/proc/pressure/cpu": [calmCpu],
      "/proc/pressure/io": [ioStalled],
      "/proc/diskstats": ioTicks.map(diskstats),
      "/proc/self/mountinfo": [localMounts],
      "/sys/block/nvme0n1/stat": [""],
      ...network,
    });
  const firstIo = (gvfsShares: Array<string> = []) =>
    Effect.gen(function* () {
      setup();
      host.gvfsShares = gvfsShares;
      const hostResources = yield* HostResources.HostResources;
      const fiber = yield* Effect.forkChild(hostResources.readPressure);
      yield* TestClock.adjust("200 millis");
      return (yield* Fiber.join(fiber)).io;
    });

  it.effect("ignores io PSI while no block device is busy and no share is mounted", () =>
    Effect.gen(function* () {
      // 3 ms with I/O in flight over 200 ms, as beside a terminal waiting in io_uring.
      expect(yield* firstIo()).toBe("none");
      expect(yield* firstIo(["smb-share:server=nas,share=work"])).toBe("severe");
    }).pipe(Effect.provide(ioPressured([1000, 1003]))),
  );

  it.effect("keeps io pressure beside idle disks only while an NFS mount is in use", () => {
    const mountstats = (lookups: number) =>
      "device nas:/work mounted on /mnt/work with fstype nfs4 statvers=1.1\n" +
      "\tage:\t5\n" +
      `\tevents:\t3 ${lookups} 0 0 0 0 0 0\n` +
      "\tbytes:\t0 0 0 0 0 0 0 0\n";
    return Effect.gen(function* () {
      setup();
      const hostResources = yield* HostResources.HostResources;
      const samples = yield* Stream.take(hostResources.pressure, 3).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("70 seconds");
      // What the mount did before the first sample is unknown for a minute. After that it is
      // idle, until a lookup that came and went between two samples moves its counters.
      expect((yield* Fiber.join(samples)).map((sample) => sample.io)).toEqual([
        "severe",
        "none",
        "severe",
      ]);
    }).pipe(
      Effect.provide(
        ioPressured([1000], {
          "/proc/self/mountinfo": [
            `${localMounts}40 22 0:61 / /mnt/work rw shared:60 - nfs4 nas:/work rw,hard\n`,
          ],
          "/proc/self/mountstats": [
            ...Array.from({ length: 14 }, () => mountstats(7)),
            mountstats(8),
          ],
        }),
      ),
    );
  });

  it.effect("reports a disk stall that the first, short reading missed", () =>
    Effect.gen(function* () {
      setup();
      const hostResources = yield* HostResources.HostResources;
      const samples = yield* Stream.take(hostResources.pressure, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("200 millis");
      yield* TestClock.adjust("5 seconds");
      // Idle for the first 200 ms, then 2 s with I/O in flight before the next sample.
      expect((yield* Fiber.join(samples)).map((sample) => sample.io)).toEqual(["none", "severe"]);
    }).pipe(Effect.provide(ioPressured([1000, 1000, 3000]))),
  );

  it.effect("reports a nearly full disk with its free space", () =>
    Effect.gen(function* () {
      setup();
      host.disk = { bavail: 3 * 1024 * 1024 * 2, blocks: 1024 * 1024 * 1024, bsize: 512 };
      const pressure = yield* (yield* HostResources.HostResources).readPressure;
      expect(pressure).toMatchObject({ disk: "severe", diskFreeBytes: 3 * GiB });
    }).pipe(
      Effect.provide(
        pressured({
          "/proc/pressure/cpu": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
        }),
      ),
    ),
  );

  it.effect("warns about a small volume that is nearly full beside a large roomy one", () =>
    Effect.gen(function* () {
      setup();
      // 1 GiB of 10 GiB is only elevated; 2 GiB of 1 TiB is severe.
      host.disk = { bavail: 2 * 1024 * 1024, blocks: 20 * 1024 * 1024, bsize: 512 };
      host.worktreesDisk = { bavail: 4 * 1024 * 1024, blocks: 2048 * 1024 * 1024, bsize: 512 };
      const pressure = yield* (yield* HostResources.HostResources).readPressure;
      expect(pressure).toMatchObject({ disk: "severe", diskFreeBytes: 2 * GiB });
    }).pipe(
      Effect.provide(
        pressured({
          "/proc/pressure/cpu": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
        }),
      ),
    ),
  );

  it.effect("keeps one statfs in flight per directory while a mount hangs", () =>
    Effect.gen(function* () {
      setup();
      host.hangStatfs = true;
      const hostResources = yield* HostResources.HostResources;
      for (let sample = 0; sample < 3; sample++) {
        const fiber = yield* Effect.forkChild(hostResources.readPressure);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
      }
      // The data and worktree directories, once each.
      expect(host.statfsCalls).toBe(2);
    }).pipe(
      Effect.provide(
        pressured({
          "/proc/pressure/cpu": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
        }),
      ),
    ),
  );

  it.effect("keeps agent-slice memory pressure while host memory PSI is unreadable", () =>
    Effect.gen(function* () {
      setup();
      const hostResources = yield* HostResources.HostResources;
      let pressure = yield* hostResources.readPressure;
      for (let sample = 0; sample < 7; sample++) pressure = yield* hostResources.readPressure;
      expect(pressure.memory).toBe("severe");
    }).pipe(
      Effect.provide(
        pressured({
          "/proc/pressure/memory": [""],
          "/proc/pressure/cpu": ["some avg10=0.00 avg60=0.00\nfull avg10=0.00 avg60=0.00\n"],
          "/sys/fs/cgroup/agents/memory.pressure": ["some avg10=90.00\nfull avg10=85.00\n"],
        }),
      ),
    ),
  );
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
      setup();
      const hostResources = yield* HostResources.HostResources;
      const [first] = yield* Stream.take(hostResources.pressure, 1).pipe(Stream.runCollect);
      expect(first?.memory).toBe("severe");
      const later = yield* Stream.take(hostResources.pressure, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      // The sidecar stops answering: the warning must not outlive the pressure.
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(later)).map((pressure) => pressure.memory)).toEqual([
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
              layerConfig,
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
