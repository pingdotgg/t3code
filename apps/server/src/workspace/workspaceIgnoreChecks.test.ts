import { it, describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import {
  IGNORE_CHECKS_PER_WORKSPACE,
  type IgnoreCheckOutput,
  makeIgnoreCheckQueue,
} from "./workspaceIgnoreChecks.ts";

type GitOutput = IgnoreCheckOutput & { readonly stdoutTruncated: boolean };

interface GitCall {
  readonly paths: ReadonlyArray<string>;
  readonly outcome: Deferred.Deferred<Effect.Effect<GitOutput, string>>;
  interrupted: boolean;
}

/** Git that ignores `*.log` and answers each call only when the test says so. */
const makeGit = Effect.gen(function* () {
  const started = yield* Queue.unbounded<GitCall>();
  const calls: Array<GitCall> = [];
  let running = 0;
  let mostRunning = 0;
  const run = (_gitCwd: string, paths: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const call: GitCall = { paths, outcome: Deferred.makeUnsafe(), interrupted: false };
      calls.push(call);
      mostRunning = Math.max(mostRunning, ++running);
      Queue.offerUnsafe(started, call);
      return Deferred.await(call.outcome).pipe(
        Effect.flatten,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            call.interrupted = true;
          }),
        ),
        Effect.ensuring(Effect.sync(() => running--)),
      );
    });
  const answer = (call: GitCall, outcome?: Effect.Effect<GitOutput, string>) => {
    const ignored = call.paths.filter((checkPath) => checkPath.endsWith(".log"));
    return Deferred.succeed(
      call.outcome,
      outcome ??
        Effect.succeed({
          exitCode: ignored.length > 0 ? 0 : 1,
          stdout: ignored.map((ignoredPath) => `${ignoredPath}\0`).join(""),
          stdoutTruncated: false,
        }),
    );
  };
  /** Waits for the next call to start. */
  const next = Queue.take(started);
  /** Answers every call, started or still to come. */
  const answerAll = Effect.forEach(calls, (call) => answer(call), { discard: true }).pipe(
    Effect.andThen(
      Queue.take(started).pipe(
        Effect.flatMap((call) => answer(call)),
        Effect.forever,
        Effect.forkScoped,
      ),
    ),
  );
  const nextFour = Effect.forEach([1, 2, 3, 4], () => next);
  return { run, calls, next, nextFour, answer, answerAll, mostRunning: () => mostRunning };
});

const folder = (name: string, shareable = true) => ({
  workspace: "/repo",
  gitCwd: "/repo",
  paths: [`${name}/drop.log`, `${name}/keep.txt`],
  shareable,
});

const labelsOf = (name: string): IgnoreCheckOutput => ({
  exitCode: 0,
  stdout: `${name}/drop.log\0`,
});

describe("makeIgnoreCheckQueue", () => {
  it.effect("frees the slots of calls whose listings all left, before or while they ran", () =>
    Effect.gen(function* () {
      const git = yield* makeGit;
      const check = yield* makeIgnoreCheckQueue(git.run);
      const running = yield* Effect.forEach(["a", "b", "c", "d"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* git.nextFour;
      const waiting = yield* Effect.forEach(["w1", "w2", "w3", "w4", "w5", "w6"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      expect(git.calls.length).toBe(IGNORE_CHECKS_PER_WORKSPACE);

      // Waiting listings leave before any call starts for them; two running ones leave mid-call.
      yield* Fiber.interruptAll(waiting);
      yield* Fiber.interrupt(running[0]!);
      yield* Fiber.interrupt(running[1]!);
      expect(git.calls.map((call) => call.interrupted)).toEqual([true, true, false, false]);

      yield* git.answerAll;
      const later = yield* Effect.forEach(["e", "f", "g", "h", "i", "j"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      expect(yield* Fiber.joinAll([running[2]!, running[3]!, ...later])).toEqual(
        ["c", "d", "e", "f", "g", "h", "i", "j"].map((name) =>
          expect.objectContaining(labelsOf(name)),
        ),
      );
      expect(git.calls.some((call) => call.paths.some((path) => path.startsWith("w")))).toBe(false);
      expect(git.mostRunning()).toBe(IGNORE_CHECKS_PER_WORKSPACE);
    }),
  );

  it.effect("fails the listings of a call that dies, and keeps serving the workspace", () =>
    Effect.gen(function* () {
      const git = yield* makeGit;
      const check = yield* makeIgnoreCheckQueue(git.run);
      const running = yield* Effect.forEach(["a", "b", "c", "d"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      const [first] = yield* git.nextFour;
      const shared = yield* Effect.forEach(["e", "f", "g"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* git.answer(first!);
      const sharedCall = yield* git.next;
      expect(sharedCall.paths).toEqual(["e", "f", "g"].flatMap((name) => folder(name).paths));
      yield* git.answer(sharedCall, Effect.die("git crashed"));

      for (const fiber of shared) {
        const exit = yield* Effect.exit(Fiber.join(fiber));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }
      yield* git.answerAll;
      expect(yield* Fiber.joinAll(running.slice(1))).toEqual(
        ["b", "c", "d"].map((name) => expect.objectContaining(labelsOf(name))),
      );
      expect(yield* check(folder("later"))).toEqual(expect.objectContaining(labelsOf("later")));
    }),
  );

  it.effect(
    "asks each folder of a timed-out or refused shared call again alone, four at once",
    () =>
      Effect.gen(function* () {
        const failures: ReadonlyArray<Effect.Effect<GitOutput, string>> = [
          Effect.fail("timed out"),
          Effect.succeed({ exitCode: 128, stdout: "", stdoutTruncated: false }),
        ];
        for (const failure of failures) {
          const git = yield* makeGit;
          const check = yield* makeIgnoreCheckQueue(git.run);
          const names = Array.from({ length: 16 }, (_, index) => `folder-${index}`);
          const fibers = yield* Effect.forEach(names, (name) =>
            check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
          );
          const [first] = yield* git.nextFour;
          yield* git.answer(first!);
          const sharedCall = yield* git.next;
          expect(sharedCall.paths).toEqual(names.slice(4).flatMap((name) => folder(name).paths));
          yield* git.answer(sharedCall, failure);
          yield* git.answerAll;

          expect(yield* Fiber.joinAll(fibers)).toEqual(
            names.map((name) => expect.objectContaining(labelsOf(name))),
          );
          // Every folder of the failed call got its own call, as it would without sharing.
          expect(git.calls.slice(5).map((call) => call.paths)).toEqual(
            names.slice(4).map((name) => folder(name).paths),
          );
          expect(git.mostRunning()).toBe(IGNORE_CHECKS_PER_WORKSPACE);
        }
      }),
  );

  it.effect("ends waiting listings when the service closes before their call can start", () =>
    Effect.gen(function* () {
      const git = yield* makeGit;
      const scope = yield* Scope.make();
      const check = yield* makeIgnoreCheckQueue(git.run).pipe(Scope.provide(scope));
      const running = yield* Effect.forEach(["a", "b", "c", "d"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* git.nextFour;
      // Six waiting checks, more than the four slots an unstarted call could leak.
      const waiting = yield* Effect.forEach(["e", "f", "g", "h", "i", "j"], (name) =>
        check(folder(name, false)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Scope.close(scope, Exit.void);
      yield* git.answerAll;

      expect(yield* Fiber.joinAll(running)).toEqual(
        ["a", "b", "c", "d"].map((name) => expect.objectContaining(labelsOf(name))),
      );
      for (const fiber of waiting) {
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(fiber)))).toBe(true);
      }
      expect(git.calls.length).toBe(IGNORE_CHECKS_PER_WORKSPACE);
    }),
  );

  it.effect("answers identical unshareable checks with one call and keeps others apart", () =>
    Effect.gen(function* () {
      const git = yield* makeGit;
      const check = yield* makeIgnoreCheckQueue(git.run);
      yield* Effect.forEach(["a", "b", "c", "d"], (name) =>
        check(folder(name)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      const [first] = yield* git.nextFour;
      const probe = { workspace: "/repo", gitCwd: "/repo", paths: ["sub/.git"], shareable: false };
      const probes = yield* Effect.forEach([1, 2, 3], () =>
        check(probe).pipe(Effect.forkChild({ startImmediately: true })),
      );
      const linked = yield* Effect.forEach(["link-1", "link-2"], (name) =>
        check(folder(name, false)).pipe(Effect.forkChild({ startImmediately: true })),
      );
      const refused = { exitCode: 128, stdout: "", stdoutTruncated: false };
      yield* git.answer(first!);
      const probeCall = yield* git.next;
      expect(probeCall.paths).toEqual(["sub/.git"]);
      yield* git.answer(probeCall, Effect.succeed(refused));
      yield* git.answerAll;

      expect(yield* Fiber.joinAll(probes)).toEqual([refused, refused, refused]);
      expect(yield* Fiber.joinAll(linked)).toEqual(
        ["link-1", "link-2"].map((name) => expect.objectContaining(labelsOf(name))),
      );
      expect(git.calls.map((call) => call.paths)).toEqual([
        ...["a", "b", "c", "d"].map((name) => folder(name).paths),
        ["sub/.git"],
        folder("link-1").paths,
        folder("link-2").paths,
      ]);
    }),
  );
});
