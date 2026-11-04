import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import { mdnsHostFromName, resolveMdnsHost } from "./mdnsHost.ts";

const spawnerWithStdout = (stdout: string) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const resolveOn = (
  platform: NodeJS.Platform,
  hostname: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  resolveMdnsHost().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Hostname, hostname),
  );

describe("mdnsHostFromName", () => {
  it("keeps the first label of a name and rejects an empty one", () => {
    expect(mdnsHostFromName("bb-1")).toBe("bb-1.local");
    expect(mdnsHostFromName("bb-1.corp.example\n")).toBe("bb-1.local");
    expect(mdnsHostFromName("Studio\n")).toBe("Studio.local");
    expect(mdnsHostFromName("")).toBeNull();
    expect(mdnsHostFromName("\n")).toBeNull();
    expect(mdnsHostFromName(".corp.example")).toBeNull();
  });
});

describe("resolveMdnsHost", () => {
  it.effect("prefers LocalHostName over a DHCP-assigned hostname on macOS", () =>
    Effect.gen(function* () {
      expect(yield* resolveOn("darwin", "dhcp-12.corp", spawnerWithStdout("Studio\n"))).toBe(
        "Studio.local",
      );
    }),
  );

  it.effect("falls back to the hostname when scutil prints nothing or cannot run", () =>
    Effect.gen(function* () {
      expect(yield* resolveOn("darwin", "dhcp-12.corp", spawnerWithStdout(""))).toBe(
        "dhcp-12.local",
      );
      expect(
        yield* resolveOn(
          "darwin",
          "dhcp-12.corp",
          ChildProcessSpawner.make(() => Effect.die("ENOTDIR")),
        ),
      ).toBe("dhcp-12.local");
    }),
  );

  it.effect("falls back to the hostname when scutil hangs past its timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        resolveOn(
          "darwin",
          "dhcp-12.corp",
          ChildProcessSpawner.make(() => Effect.never),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("dhcp-12.local");
    }),
  );

  it.effect("never runs scutil off macOS", () =>
    Effect.gen(function* () {
      const spawns = yield* Ref.make(0);
      expect(
        yield* resolveOn(
          "linux",
          "bb-1.corp",
          ChildProcessSpawner.make(() =>
            Ref.update(spawns, (count) => count + 1).pipe(Effect.andThen(Effect.die("spawned"))),
          ),
        ),
      ).toBe("bb-1.local");
      expect(yield* Ref.get(spawns)).toBe(0);
    }),
  );
});
