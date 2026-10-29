import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  heaviestAgents,
  HostResources,
  layer as hostResourcesLayer,
  type MemoryPressureSample,
  nextMemoryPressureLevel,
  psiAvg10,
  roundAgentMemory,
} from "./HostResources.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

const quiet: MemoryPressureSample = {
  hostSome: 0,
  hostFull: 0,
  agentsFull: 0,
  darwinLevel: null,
};

describe("memory pressure level", () => {
  it("reads PSI averages", () => {
    const text =
      "some avg10=12.50 avg60=3.10 avg300=0.80 total=1\nfull avg10=4.00 avg60=1.00 avg300=0.10 total=1\n";
    expect(psiAvg10(text, "some")).toBe(12.5);
    expect(psiAvg10(text, "full")).toBe(4);
    expect(psiAvg10("", "full")).toBeNull();
  });

  it("keeps small agents listed while rounding large ones coarsely", () => {
    const MiB = 1024 * 1024;
    expect(roundAgentMemory(27_648_000)).toBe(28 * MiB);
    expect(roundAgentMemory(3_200 * MiB + 1)).toBe(3_328 * MiB);
    expect(roundAgentMemory(0)).toBe(0);
  });

  it("ranks agents by exact size, so close ones cannot push out the largest", () => {
    const MiB = 1024 * 1024;
    // All four round to 3,328 MiB; the largest comes last.
    const agents = [3_201, 3_202, 3_203, 3_204].map((size) => ({
      threadId: null,
      agent: `agent-${size}`,
      memoryBytes: size * MiB,
    }));
    expect(heaviestAgents(agents).map((agent) => agent.agent)).toEqual([
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
    expect(nextMemoryPressureLevel(previous, sample)).toBe(level);
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
      const hostResources = yield* HostResources;
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
        hostResourcesLayer.pipe(
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
