import { PlatformServices } from "@/Util/PlatformServices.ts";
import { assert, describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import {
  assertPidExited,
  killPid,
  pidListeningOn,
  waitForExit,
} from "./fixtures/process-effect.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("./fixtures/dev-cli/", import.meta.url),
);
const ALCHEMY_BIN = fileURLToPath(
  new URL("../../bin/alchemy.ts", import.meta.url),
);

/** Every live pid on the system with its parent and command (POSIX). */
const processTable = ChildProcess.make("ps", ["-Ao", "pid=,ppid=,comm="], {
  stdout: "pipe",
}).pipe(
  Effect.flatMap((handle) =>
    handle.stdout.pipe(Stream.decodeText, Stream.mkString),
  ),
  Effect.map((stdout) =>
    stdout.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              command: match[3]!,
            },
          ]
        : [];
    }),
  ),
);

/** Transitive children of `root`, resolved to a fixpoint over the table. */
const descendantsOf = (root: number) =>
  processTable.pipe(
    Effect.map((table) => {
      const pids = new Set([root]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const entry of table) {
          if (pids.has(entry.ppid) && !pids.has(entry.pid)) {
            pids.add(entry.pid);
            grew = true;
          }
        }
      }
      return table.filter((entry) => entry.pid !== root && pids.has(entry.pid));
    }),
  );

describe.skipIf(process.platform === "win32" || process.env.FAST)(
  "alchemy dev CLI process cleanup",
  () => {
    // Expected failure: SIGKILL cannot be trapped, so nothing kills the
    // exec child, the provider sidecar, or workerd on the CLI's behalf.
    // When the orphan story lands this starts passing — flip it to a
    // regular test then.
    it.live.fails(
      "every spawned process exits after the CLI is SIGKILLed",
      () =>
        Effect.gen(function* () {
          let output = "";
          const child = yield* ChildProcess.make(
            "bun",
            [ALCHEMY_BIN, "dev", "alchemy.run.ts", "--stage", "kill-test"],
            {
              cwd: FIXTURE_DIR,
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "1 second",
              // The stack is fully local (localState + local worker), so
              // placeholder credentials satisfy the provider's env lookup
              // without any cloud call being possible.
              env: {
                CI: "1",
                CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
                CLOUDFLARE_API_TOKEN: "dev-cli-kill-test-placeholder",
              },
              extendEnv: true,
            },
          );
          const collect = (stream: typeof child.stdout) =>
            stream.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  output += chunk;
                }),
              ),
              Effect.ignore,
              Effect.forkScoped,
            );
          yield* collect(child.stdout);
          yield* collect(child.stderr);

          // The stack outputs print once the dev deploy has converged and
          // workerd is serving the local worker.
          const match = yield* Effect.sync(
            () => output.match(/workerUrl[^h]*(http[^\s'",]+)/)?.[1],
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (value) => value !== undefined,
              times: 240,
            }),
          );
          if (typeof match !== "string") {
            return yield* Effect.die(
              new Error(
                `alchemy dev never printed the worker url.\n--- output tail ---\n${output.slice(-4_000)}`,
              ),
            );
          }
          const url = match;
          yield* Effect.tryPromise(() => fetch(url)).pipe(
            Effect.retry({
              schedule: Schedule.spaced("500 millis"),
              times: 40,
            }),
          );

          const workerdPid = yield* pidListeningOn(url);
          const tracked = yield* descendantsOf(child.pid);
          assert(
            tracked.some((entry) => entry.pid === workerdPid),
            `workerd (pid ${workerdPid}) is not a descendant of the CLI:\n${JSON.stringify(tracked, null, 2)}`,
          );
          // Reap survivors unconditionally so the expected failure never
          // leaks processes into the rest of the suite.
          yield* Effect.addFinalizer(() =>
            Effect.forEach(tracked, (entry) =>
              killPid(entry.pid, "SIGKILL"),
            ).pipe(Effect.asVoid),
          );

          yield* killPid(child.pid, "SIGKILL");
          yield* waitForExit(child, Duration.seconds(10));

          const survivors: string[] = [];
          yield* Effect.forEach(tracked, (entry) =>
            assertPidExited(entry.pid).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  survivors.push(`${entry.pid} ${entry.command}`);
                }),
              ),
            ),
          );
          expect(survivors).toEqual([]);
        }).pipe(Effect.provide(PlatformServices)),
      { timeout: 180_000 },
    );
  },
);
