import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  isLocalSshDeviceHost,
  LocalDeviceHostAddresses,
  remoteSshDeviceHosts,
} from "./localSshDeviceHost.ts";

const host = (target: string, port?: number) => ({
  id: target,
  label: target,
  target,
  ...(port ? { port } : {}),
});
const spawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
    // Any attempt to actually connect fails this test.
    expect(command.args).toContain("-G");
    const target = command.args.at(-1);
    const configs: Record<string, string> = {
      "mac-mini": "hostname 100.65.180.100\nport 22\n",
      remote: "hostname 192.0.2.1\nport 22\n",
      loopback: "hostname 127.0.1.1\nport 22\n",
      ipv6: "hostname ::1\nport 22\n",
      forwarded: "hostname 127.0.0.1\nport 2222\n",
      proxy: "hostname 127.0.0.1\nport 22\nproxyjump bastion\n",
      command: "hostname 127.0.0.1\nport 22\nproxycommand nc remote 22\n",
      unresolved: "hostname example.invalid\nport 22\n",
    };
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: Stream.make(new TextEncoder().encode(configs[target ?? ""] ?? "")),
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }),
);
const provide = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof isLocalSshDeviceHost>>>,
) =>
  effect.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(LocalDeviceHostAddresses, new Set(["100.65.180.100"])),
    Effect.provide(NodeServices.layer),
  );

it.effect("skips SSH aliases resolving to this machine, including loopback", () =>
  provide(
    Effect.gen(function* () {
      for (const target of ["mac-mini", "loopback", "ipv6"]) {
        expect(yield* isLocalSshDeviceHost(host(target))).toBe(true);
      }
    }),
  ),
);

it.effect("keeps remote, forwarded, proxied, and unresolved destinations", () =>
  provide(
    Effect.gen(function* () {
      for (const target of ["remote", "forwarded", "proxy", "command", "unresolved"]) {
        expect(yield* isLocalSshDeviceHost(host(target))).toBe(false);
      }
    }),
  ),
);

it.effect("removes only self targets from a fanned-out host list", () =>
  provide(
    Effect.gen(function* () {
      expect(
        yield* remoteSshDeviceHosts([host("mac-mini"), host("remote"), host("forwarded")]),
      ).toEqual([host("remote"), host("forwarded")]);
    }),
  ),
);
