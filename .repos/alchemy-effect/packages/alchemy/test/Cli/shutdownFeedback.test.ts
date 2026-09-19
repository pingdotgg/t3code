import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/shutdown-feedback-fixture.ts", import.meta.url),
);

/**
 * Spawn the fixture (piped stdio, so the feedback takes the non-TTY log-line
 * branch), wait for its ready line, and expose accumulated stderr.
 */
const spawnFixture = (env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bun", [FIXTURE], {
      env,
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    const chunks: string[] = [];
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.includes("ready")),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeout(Duration.seconds(10)),
    );
    return {
      handle,
      sigint: Effect.sync(() => process.kill(handle.pid, "SIGINT")),
      stderr: () => chunks.join(""),
    };
  });

const waitForStderr = (read: () => string, text: string) =>
  Effect.sync(read).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(50)),
      until: (output) => output.includes(text),
      times: 100,
    }),
    Effect.flatMap((output) =>
      output.includes(text)
        ? Effect.void
        : Effect.fail(
            new Error(
              `stderr never contained ${JSON.stringify(text)}: ${output}`,
            ),
          ),
    ),
  );

describe("shutdown feedback", () => {
  it.live(
    "a slow shutdown prints one delayed status line",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          SHUTDOWN_FIXTURE_EXIT_AFTER_MS: "800",
        });
        yield* fixture.sigint;
        yield* Effect.sleep(Duration.millis(300));
        expect(fixture.stderr()).not.toContain("Shutting down");
        yield* waitForStderr(fixture.stderr, "Shutting down");
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.stderr().match(/Shutting down/g)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  it.live(
    "a shutdown finishing within the delay stays silent",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          SHUTDOWN_FIXTURE_EXIT_AFTER_MS: "50",
        });
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.stderr()).not.toContain("Shutting down");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );

  it.live(
    "a suppressed process stays silent",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          SHUTDOWN_FIXTURE_SUPPRESS: "1",
          SHUTDOWN_FIXTURE_EXIT_AFTER_MS: "800",
        });
        yield* fixture.sigint;
        expect(yield* fixture.handle.exitCode).toBe(0);
        expect(fixture.stderr()).not.toContain("Shutting down");
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 30_000 },
  );
});
