// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export class BootstrapFdStatError extends Schema.TaggedError<BootstrapFdStatError>()(
  "BootstrapFdStatError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat bootstrap file descriptor ${this.fd}.`;
  }
}

export class BootstrapInputStreamOpenError extends Schema.TaggedError<BootstrapInputStreamOpenError>()(
  "BootstrapInputStreamOpenError",
  {
    fd: Schema.Number,
    platform: Schema.String,
    fdPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const path = this.fdPath === undefined ? "" : ` via '${this.fdPath}'`;
    return `Failed to open bootstrap input stream for file descriptor ${this.fd}${path} on '${this.platform}'.`;
  }
}

export class BootstrapEnvelopeReadError extends Schema.TaggedError<BootstrapEnvelopeReadError>()(
  "BootstrapEnvelopeReadError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export class BootstrapEnvelopeDecodeError extends Schema.TaggedError<BootstrapEnvelopeDecodeError>()(
  "BootstrapEnvelopeDecodeError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export class BootstrapEnvelopeMissingError extends Schema.TaggedError<BootstrapEnvelopeMissingError>()(
  "BootstrapEnvelopeMissingError",
  { fd: Schema.Number },
) {
  override get message(): string {
    return `Bootstrap input on file descriptor ${this.fd} closed without an envelope.`;
  }
}

export class BootstrapEnvelopeTimeoutError extends Schema.TaggedError<BootstrapEnvelopeTimeoutError>()(
  "BootstrapEnvelopeTimeoutError",
  { fd: Schema.Number, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Timed out waiting for bootstrap envelope from file descriptor ${this.fd} after ${this.timeoutMs} ms.`;
  }
}

export const BootstrapError = Schema.Union([
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  BootstrapEnvelopeReadError,
  BootstrapEnvelopeDecodeError,
  BootstrapEnvelopeMissingError,
  BootstrapEnvelopeTimeoutError,
]);
export type BootstrapError = typeof BootstrapError.Type;

export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* <A, I>(
  schema: Schema.Codec<A, I>,
  fd: number,
  options?: {
    timeoutMs?: number;
  },
): Effect.fn.Return<A, BootstrapError> {
  yield* Effect.try({
    try: () => NodeFS.fstatSync(fd),
    catch: (cause) => new BootstrapFdStatError({ fd, cause }),
  });

  const stream = yield* makeBootstrapInputStream(fd);

  // An explicit bootstrap fd is required startup input. Allow cold reads time
  // to complete, but fail before the desktop's one-minute readiness deadline.
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return yield* Effect.callback<
    A,
    BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError | BootstrapEnvelopeMissingError
  >((resume) => {
    const input = NodeReadline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const cleanup = () => {
      input.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
      stream.destroy();
    };

    const finish = (result: Parameters<typeof resume>[0]) =>
      resume(result.pipe(Effect.ensuring(Effect.sync(cleanup))));

    const handleError = (error: Error) => {
      finish(
        Effect.fail(
          new BootstrapEnvelopeReadError({
            fd,
            cause: error,
          }),
        ),
      );
    };

    const handleLine = (line: string) => {
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        finish(Effect.succeed(parsed.success));
      } else {
        finish(
          Effect.fail(
            new BootstrapEnvelopeDecodeError({
              fd,
              cause: parsed.failure,
            }),
          ),
        );
      }
    };

    const handleClose = () => {
      finish(Effect.fail(new BootstrapEnvelopeMissingError({ fd })));
    };

    input.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new BootstrapEnvelopeTimeoutError({ fd, timeoutMs })),
    }),
  );
});

const makeBootstrapInputStream = (fd: number) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const fdPath = resolveFdPath(fd, platform);
    return yield* Effect.try<NodeStream.Readable, BootstrapInputStreamOpenError>({
      try: () => {
        if (fdPath === undefined) {
          return makeDirectBootstrapStream(fd);
        }

        let streamFd: number | undefined;
        try {
          streamFd = NodeFS.openSync(fdPath, "r");
          return NodeFS.createReadStream("", {
            fd: streamFd,
            encoding: "utf8",
            autoClose: true,
          });
        } catch (error) {
          if (isBootstrapFdPathDuplicationError(error)) {
            if (streamFd !== undefined) {
              NodeFS.closeSync(streamFd);
            }
            return makeDirectBootstrapStream(fd);
          }
          throw error;
        }
      },
      catch: (error) =>
        new BootstrapInputStreamOpenError({
          fd,
          platform,
          ...(fdPath === undefined ? {} : { fdPath }),
          cause: error,
        }),
    });
  });

const makeDirectBootstrapStream = (fd: number): NodeStream.Readable => {
  try {
    return NodeFS.createReadStream("", {
      fd,
      encoding: "utf8",
      autoClose: true,
    });
  } catch {
    const stream = new NodeNet.Socket({
      fd,
      readable: true,
      writable: false,
    });
    stream.setEncoding("utf8");
    return stream;
  }
};

// Stdin pipes inherited across the wsl.exe boundary report EACCES when we try
// to re-open them via /proc/self/fd/0 — fall back to reading the fd directly
// in that case, the same way we already do for ENXIO/EINVAL/EPERM.
const isBootstrapFdPathDuplicationError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "ENXIO" || _.code === "EINVAL" || _.code === "EPERM" || _.code === "EACCES",
);

function resolveFdPath(fd: number, platform: NodeJS.Platform): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
