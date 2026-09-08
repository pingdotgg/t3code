import type { ScopedPlanStatusSession } from "@/Cli/Cli.ts";
import * as Command from "@/Command";
import * as Test from "@/Test/Alchemy";
import { assert, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as pathe from "pathe";
const { test } = Test.make({ providers: Command.providers() });

const session = (notes: Array<string>) =>
  ({
    note: (note: string) =>
      Effect.sync(() => {
        notes.push(note);
      }),
  }) as unknown as ScopedPlanStatusSession;

const withExecutor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Command.CommandExecutorLive()));

test(
  "returns stdout and stderr for a successful command",
  withExecutor(
    Effect.gen(function* () {
      const executor = yield* Command.CommandExecutor;
      const notes: Array<string> = [];
      const result = yield* executor.run(
        {
          command: "printf 'hello'; printf 'warning' >&2",
          shell: true,
        },
        session(notes),
      );

      expect(result).toEqual({
        exitCode: 0,
        stdout: "hello",
        stderr: "warning",
      });
      expect(notes).toEqual(expect.arrayContaining(["hello", "warning"]));
    }),
  ),
  { timeout: 30_000 },
);

test(
  "returns a typed failure for a non-zero exit",
  withExecutor(
    Effect.gen(function* () {
      const executor = yield* Command.CommandExecutor;
      const error = yield* executor
        .run(
          {
            command: "printf 'plain failure' >&2; exit 7",
            shell: true,
          },
          session([]),
        )
        .pipe(Effect.flip);

      assert(Command.isCommandError(error));
      assert(error.reason._tag === "UnexpectedExit");
      expect(error.reason.exitCode).toBe(7);
      expect(error.reason.stderr).toBe("plain failure");
      expect(error.message).toContain("exited with code 7");
    }),
  ),
  { timeout: 30_000 },
);

test(
  "times out and terminates descendants that ignore SIGTERM",
  withExecutor(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const executor = yield* Command.CommandExecutor;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const pidFile = pathe.join(cwd, "child.pid");

      const invalid = yield* executor
        .run({ command: "true", shell: true, timeout: 0 }, session([]))
        .pipe(Effect.flip);
      assert(Command.isCommandError(invalid));
      assert(invalid.reason._tag === "BadArgument");
      expect(invalid.message).toContain("positive finite duration");

      const error = yield* executor
        .run(
          {
            command: 'trap \'\' TERM; sleep 30 & echo "$!" > "$PID_FILE"; wait',
            cwd,
            env: { PID_FILE: pidFile },
            shell: true,
            timeout: "100 millis",
          },
          session([]),
        )
        .pipe(Effect.flip);

      assert(Command.isCommandError(error));
      assert(error.reason._tag === "CommandTimedOut");
      expect(error.reason.timeout).toBe("100ms");
      expect(error.message).toContain("process group was terminated");

      const childPid = Number((yield* fs.readFileString(pidFile)).trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);

      let alive = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        alive = yield* Effect.sync(() => {
          try {
            process.kill(childPid, 0);
            return true;
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ESRCH"
            ) {
              return false;
            }
            throw cause;
          }
        });
        if (!alive) break;
        yield* Effect.sleep("50 millis");
      }
      expect(alive).toBe(false);
    }),
  ),
  { timeout: 30_000 },
);

test(
  "redacts Redacted env values across chunks, notes, results, and errors",
  withExecutor(
    Effect.gen(function* () {
      const executor = yield* Command.CommandExecutor;
      const secret = "super-secret-value";
      const notes: Array<string> = [];
      const splitSecret =
        "printf 'super-secret-'; sleep 0.05; printf 'value\\n'; " +
        "printf 'super-secret-' >&2; sleep 0.05; printf 'value\\n' >&2";
      const props = {
        command: splitSecret,
        shell: true,
        env: { SECRET: Redacted.make(secret) },
      } as const;

      const result = yield* executor.run(props, session(notes));
      expect(result.stdout).toBe("[REDACTED]\n");
      expect(result.stderr).toBe("[REDACTED]\n");
      expect(notes.join("\n")).not.toContain(secret);
      expect(notes.join("\n")).toContain("[REDACTED]");

      const error = yield* executor
        .run(
          {
            command: "printf '%s\\n' \"$SECRET\" >&2; exit 9",
            shell: true,
            env: { SECRET: Redacted.make(secret) },
          },
          session(notes),
        )
        .pipe(Effect.flip);

      assert(Command.isCommandError(error));
      assert(error.reason._tag === "UnexpectedExit");
      expect(error.reason.stderr).toBe("[REDACTED]\n");
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(notes.join("\n")).not.toContain(secret);

      const spawnError = yield* executor
        .run(
          {
            command: secret,
            env: { SECRET: Redacted.make(secret) },
          },
          session(notes),
        )
        .pipe(Effect.flip);
      assert(Command.isCommandError(spawnError));
      expect(spawnError.message).not.toContain(secret);
      expect(JSON.stringify(spawnError)).not.toContain(secret);

      // Even the conventional marker itself can be a legitimate secret. The
      // replacement must never reproduce that exact value.
      const markerCollision = "[REDACTED]";
      const collisionNotes: Array<string> = [];
      const collision = yield* executor.run(
        {
          command: "printf '%s' \"$SECRET\"",
          shell: true,
          env: { SECRET: Redacted.make(markerCollision) },
        },
        session(collisionNotes),
      );
      expect(collision.stdout).not.toContain(markerCollision);
      expect(collisionNotes.join("\n")).not.toContain(markerCollision);
    }),
  ),
  { timeout: 30_000 },
);
