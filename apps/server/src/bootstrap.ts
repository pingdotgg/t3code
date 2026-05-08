// @effect-diagnostics nodeBuiltinImport:off
import * as NFS from "node:fs";
import * as Net from "node:net";
import * as readline from "node:readline";
import type { Readable } from "node:stream";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* <A, I>(
  schema: Schema.Codec<A, I>,
  fd: number,
  options?: {
    timeoutMs?: number;
  },
): Effect.fn.Return<Option.Option<A>, BootstrapError> {
  const fdReady = yield* isFdReady(fd);
  if (!fdReady) return Option.none();

  const stream = yield* makeBootstrapInputStream(fd);

  const timeoutMs = options?.timeoutMs ?? 1000;

  return yield* Effect.callback<Option.Option<A>, BootstrapError>((resume) => {
    const input = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const cleanup = () => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
      stream.destroy();
    };

    const handleError = (error: Error) => {
      if (isUnavailableBootstrapFdError(error)) {
        resume(Effect.succeedNone);
        return;
      }
      resume(
        Effect.fail(
          new BootstrapError({
            message: "Failed to read bootstrap envelope.",
            cause: error,
          }),
        ),
      );
    };

    const handleLine = (line: string) => {
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        resume(Effect.succeedSome(parsed.success));
      } else {
        resume(
          Effect.fail(
            new BootstrapError({
              message: "Failed to decode bootstrap envelope.",
              cause: parsed.failure,
            }),
          ),
        );
      }
    };

    const handleClose = () => {
      resume(Effect.succeedNone);
    };

    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(cleanup);
  }).pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.flatten));
});

const isUnavailableBootstrapFdError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "EBADF" || _.code === "ENOENT",
);

const isFdReady = (fd: number) =>
  Effect.try({
    try: () => NFS.fstatSync(fd),
    catch: (error) =>
      new BootstrapError({
        message: "Failed to stat bootstrap fd.",
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => isUnavailableBootstrapFdError(error.cause),
      () => Effect.succeed(false),
    ),
  );

const makeBootstrapInputStream = (fd: number) =>
  Effect.try<Readable, BootstrapError>({
    try: () => {
      const fdPath = resolveFdPath(fd);
      if (fdPath === undefined) {
        return makeDirectBootstrapStream(fd);
      }

      let streamFd: number | undefined;
      try {
        streamFd = NFS.openSync(fdPath, "r");
        return NFS.createReadStream("", {
          fd: streamFd,
          encoding: "utf8",
          autoClose: true,
        });
      } catch (error) {
        if (isBootstrapFdPathDuplicationError(error)) {
          if (streamFd !== undefined) {
            NFS.closeSync(streamFd);
          }
          return makeDirectBootstrapStream(fd);
        }
        throw error;
      }
    },
    catch: (error) =>
      new BootstrapError({
        message: "Failed to duplicate bootstrap fd.",
        cause: error,
      }),
  });

const makeDirectBootstrapStream = (fd: number): Readable => {
  try {
    return NFS.createReadStream("", {
      fd,
      encoding: "utf8",
      autoClose: true,
    });
  } catch {
    const stream = new Net.Socket({
      fd,
      readable: true,
      writable: false,
    });
    stream.setEncoding("utf8");
    return stream;
  }
};

const isBootstrapFdPathDuplicationError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "ENXIO" || _.code === "EINVAL" || _.code === "EPERM",
);

export function resolveFdPath(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
