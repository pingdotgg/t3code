import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { probeSourceControlProvider } from "./SourceControlProviderDiscovery.ts";

it.effect("reports an incompatible gh without failing discovery or later process requests", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand" && command.command === "gh") {
        return Effect.sync(() => {
          throw Object.assign(new Error("spawn Unknown system error -86"), {
            errno: -86,
            syscall: "spawn",
            code: "Unknown system error -86",
          });
        });
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make("git version 2.50.0")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const runner = yield* ProcessRunner.make().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    const result = yield* probeSourceControlProvider({
      process,
      cwd: "/repo",
      spec: {
        type: "cli",
        kind: "github",
        label: "GitHub",
        executable: "gh",
        versionArgs: ["--version"],
        authArgs: ["auth", "status"],
        installHint: "Install GitHub CLI.",
        parseAuth: () => {
          throw new Error("Unavailable gh must not be probed for auth");
        },
      },
    });
    expect(result.status).toBe("missing");
    expect(Option.getOrNull(result.detail)).toContain("/usr/local/bin/gh");
    expect(Option.getOrNull(result.detail)).toContain("incompatible CPU architecture");
    expect(result.auth.detail).toEqual(result.detail);
    const next = yield* process.run({
      operation: "test.version",
      command: "git",
      args: ["--version"],
      cwd: "/repo",
    });
    expect(next.stdout).toBe("git version 2.50.0");
  }).pipe(Effect.provideService(SpawnExecutableResolution, () => "/usr/local/bin/gh")),
);
