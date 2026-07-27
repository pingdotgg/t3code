import { PlatformServices } from "@/Util/PlatformServices.ts";
import { assert, describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
const DEVSERVER_PARENT_TS = fileURLToPath(
  new URL("./fixtures/rpc-spawner-devserver-parent.ts", import.meta.url),
);
const DEVSERVER_SIDECAR_TS_URL = new URL(
  "../../src/Command/Local.ts",
  import.meta.url,
).toString();
const LONG_RUNNING_CJS = fileURLToPath(
  new URL("../Command/fixture/long-running.cjs", import.meta.url),
);

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
        // The parent fixture live-transforms TypeScript and spawns a second
        // process doing the same; under worker contention (and on Windows,
        // where process spawn is slower) this can take well over 5 seconds.
        Effect.timeout("30 seconds"),
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

    it.live(
      "DevServer child dies after parent receives SIGTERM",
      () =>
        Effect.gen(function* () {
          const [bin, ...args] = runtime.argv(DEVSERVER_PARENT_TS);
          const fs = yield* FileSystem.FileSystem;
          // `/tmp` doesn't exist on Windows — use a real temp directory.
          const tmpDir = yield* fs.makeTempDirectory({
            prefix: "alchemy-devserver-",
          });
          const pidFile = `${tmpDir}/${process.pid}-${runtime.name}.json`;
          const child = yield* ChildProcess.make(
            bin,
            [
              ...args,
              DEVSERVER_SIDECAR_TS_URL,
              `node ${LONG_RUNNING_CJS}`,
              pidFile,
            ],
            {
              stdout: "pipe",
              forceKillAfter: "1 second",
            },
          );
          const output = yield* child.stdout.pipe(
            Stream.decodeText,
            Stream.run(
              Sink.fold(
                () => "",
                (acc) =>
                  !acc.includes("PARENT_PID=") ||
                  !acc.includes("DEVSERVER_PID="),
                (acc, chunk) => Effect.succeed(acc + chunk),
              ),
            ),
            // See `launch` above — fixture startup can exceed 10s under
            // contention and on Windows.
            Effect.timeout("30 seconds"),
          );

          const parentPid = Number.parseInt(
            output.match(/PARENT_PID=(\d+)/)?.[1]!,
            10,
          );
          const devServerPid = Number.parseInt(
            output.match(/DEVSERVER_PID=(\d+)/)?.[1]!,
            10,
          );

          assert(
            !Number.isNaN(parentPid),
            `parent pid not found in output: ${output}`,
          );
          assert(
            !Number.isNaN(devServerPid),
            `dev server pid not found in output: ${output}`,
          );

          yield* Effect.addFinalizer(() => killPid(devServerPid, "SIGKILL"));

          expect(yield* isAlive(devServerPid)).toBe(true);
          yield* killPid(parentPid, "SIGTERM");
          yield* waitForExit(child, Duration.seconds(10));
          yield* assertPidExited(devServerPid);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 45_000 },
    );
  });
}
