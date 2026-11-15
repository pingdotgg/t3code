// @effect-diagnostics nodeBuiltinImport:off - lstat must see a dangling symlink, which FileSystem.exists follows.
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CheckoutCloner from "../../vcs/CheckoutCloner.ts";

const MAX_STDERR_CHARS = 4096;

/**
 * GNU `cp --reflink=always`, which fails rather than copy where the drive cannot share blocks. It
 * keeps nanosecond mtimes, which the checkout cache needs to trust its clones.
 */
export const makeReflinkCloner = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("ReflinkCloner.clone")(function* (source: string, destination: string) {
    const failure = (cause?: unknown) =>
      new CheckoutCloner.CheckoutCloneError({ source, destination, cause });
    const lstatError = yield* Effect.promise(() =>
      NodeFSP.lstat(destination).then(
        () => null,
        (error: NodeJS.ErrnoException) => error,
      ),
    );
    if (lstatError?.code !== "ENOENT") {
      return yield* failure(lstatError ?? new Error("the destination already exists"));
    }
    yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "cp",
          [
            "--reflink=always",
            "-R",
            "-P",
            "--preserve=mode,timestamps",
            "-T",
            "--",
            source,
            destination,
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        ),
      );
      const [stderr, exitCode] = yield* Effect.all(
        [
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) =>
                text.length >= MAX_STDERR_CHARS ? text : (text + chunk).slice(0, MAX_STDERR_CHARS),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: 2 },
      );
      if (exitCode !== 0) {
        return yield* failure(new Error(stderr.trim() || `cp exited with code ${exitCode}`));
      }
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => (error._tag === "CheckoutCloneError" ? error : failure(error))),
      // cp leaves the folders and symlinks it made before a clone failed.
      Effect.onError(() =>
        Effect.promise(() =>
          NodeFSP.rm(destination, { recursive: true, force: true }).catch(() => undefined),
        ),
      ),
    );
  });
});

/** Linux gets `cp --reflink`; every other platform keeps upstream's cloner. */
export const layer = Layer.unwrap(
  Effect.map(HostProcess.Platform, (platform) =>
    platform === "linux"
      ? Layer.effect(CheckoutCloner.CheckoutCloner, makeReflinkCloner)
      : CheckoutCloner.layer,
  ),
);
