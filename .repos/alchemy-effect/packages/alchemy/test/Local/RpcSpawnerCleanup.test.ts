import { PlatformServices } from "@/Util/PlatformServices.ts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import {
  assertPidExited,
  isAlive,
  killPid,
  pidListeningOn,
  waitForExit,
} from "./fixtures/process-effect.ts";
import { runtimes } from "./fixtures/runtimes.ts";

const PARENT_TS = fileURLToPath(
  new URL("./fixtures/rpc-spawner-parent.ts", import.meta.url),
);
const CHILD_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();

for (const runtime of runtimes()) {
  describe(`Local.RpcSpawner cleanup (${runtime.name})`, () => {
    /**
     * Boots the parent fixture and waits until it has reported both its own
     * pid and the child's RPC url (from which we resolve the child's pid via
     * `lsof`). Retries the stdout parse on a schedule until both fields are
     * populated.
     */
    const launch = Effect.gen(function* () {
      const [bin, ...args] = runtime.argv(PARENT_TS);
      const child = yield* ChildProcess.make(bin, [...args, CHILD_TS_URL], {
        stdout: "pipe",
        forceKillAfter: "1 second",
      });
      const output = yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.run(
          Sink.fold(
            () => "",
            (acc) =>
              !acc.includes("CHILD_URL=") || !acc.includes("PARENT_PID="),
            (acc, chunk) => Effect.succeed(acc + chunk),
          ),
        ),
        Effect.timeout("5 seconds"),
      );

      const childUrl = output.match(/CHILD_URL=(\S+)/)?.[1];
      const parentPid = Number.parseInt(
        output.match(/PARENT_PID=(\d+)/)?.[1]!,
        10,
      );

      assert(childUrl, `child url not found in output: ${output}`);
      assert(
        !Number.isNaN(parentPid),
        `parent pid not found in output: ${output}`,
      );

      const childPid = yield* pidListeningOn(childUrl);

      yield* Effect.addFinalizer(() => killPid(childPid, "SIGKILL"));

      return {
        child,
        parentPid,
        childPid,
      };
    });

    it.live(
      "child dies after parent receives SIGTERM",
      () =>
        Effect.gen(function* () {
          const { child, parentPid, childPid } = yield* launch;
          expect(yield* isAlive(childPid)).toBe(true);
          yield* killPid(parentPid, "SIGTERM");
          // waitForExit wraps `handle.exitCode`, which resolves once
          // the OS reports the parent's exit.
          yield* waitForExit(child, Duration.seconds(10));
          yield* assertPidExited(childPid);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 45_000 },
    );

    it.live(
      "child dies after parent receives SIGKILL",
      () =>
        Effect.gen(function* () {
          const { child, parentPid, childPid } = yield* launch;
          expect(yield* isAlive(childPid)).toBe(true);
          yield* killPid(parentPid, "SIGKILL");
          yield* waitForExit(child, Duration.seconds(10));
          yield* assertPidExited(childPid);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 45_000 },
    );
  });
}
