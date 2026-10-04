import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/**
 * Run a read-only installer query (`brew info`, `mise ls`, …) and return its
 * stdout, or null on a non-zero exit, timeout, or oversized output.
 */
export const runInstallerProbe = Effect.fn("runInstallerProbe")(function* (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: Duration.Input;
  readonly maxBytes: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // Windows installers may be `.cmd` shims, which need the shell to launch.
    const resolved = yield* resolveSpawnCommand(input.executable, input.args, {
      env: input.env,
      extendEnv: true,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        shell: resolved.shell,
        env: input.env,
        extendEnv: true,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr is drained so a chatty installer cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: input.maxBytes }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) !== 0 || stdout.truncated ? null : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(input.timeout),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Installer probe failed", {
        executable: input.executable,
        subcommand: input.args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});
