// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export class BootstrapFdStatError extends Schema.TaggedErrorClass<BootstrapFdStatError>()(
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

export class BootstrapInputStreamOpenError extends Schema.TaggedErrorClass<BootstrapInputStreamOpenError>()(
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

export class BootstrapEnvelopeReadError extends Schema.TaggedErrorClass<BootstrapEnvelopeReadError>()(
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

export class BootstrapEnvelopeDecodeError extends Schema.TaggedErrorClass<BootstrapEnvelopeDecodeError>()(
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

export const BootstrapError = Schema.Union([
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  BootstrapEnvelopeReadError,
  BootstrapEnvelopeDecodeError,
]);
export type BootstrapError = typeof BootstrapError.Type;

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

  return yield* Effect.callback<
    Option.Option<A>,
    BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError
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

    // Every branch below is terminal -- it resolves the envelope read one way
    // or another -- so each one stops reading from `fd` before resuming.
    // Without this, the readline interface and its backing stream stay
    // attached and keep reading from `fd` for the rest of the process
    // lifetime. That was harmless while the desktop side closed stdin right
    // after writing the bootstrap line (the stream would hit EOF almost
    // immediately either way), but it stopped being harmless once the WSL
    // bootstrap path started holding stdin open indefinitely (see
    // DesktopBackendManager.ts's runBackendProcess): a readline interface
    // left idling on a never-closing, wsl.exe-relayed stdin pipe can surface
    // a spurious EAGAIN 'error' event on that stream well after the envelope
    // was already read.
    //
    // The error listener is registered on the readline *interface* (`input`),
    // not the raw `stream`, and deliberately not on both. Node's
    // readline.Interface attaches its own internal 'error' listener to the
    // input stream at construction time and, on error, re-emits onto itself
    // (node:internal/readline/interface.js); that internal listener runs
    // before any listener registered on `stream` afterward, and a thrown
    // exception from one stream listener prevents later ones on the same
    // stream from running at all -- so a `stream.once("error", ...)`
    // registered here would never fire for an error that happens before the
    // first line ever arrives (verified directly: an error emitted on
    // `stream` before any "line"/"close" event is an uncaught exception with
    // only a stream-level listener, since readline's re-emit-with-no-listener
    // on the interface throws first). Listening on `input` instead receives
    // the same re-emitted error reliably, exactly once, in every case.
    const handleError = (error: Error) => {
      cleanup();
      if (isUnavailableBootstrapFdError(error)) {
        resume(Effect.succeedNone);
        return;
      }
      resume(
        Effect.fail(
          new BootstrapEnvelopeReadError({
            fd,
            cause: error,
          }),
        ),
      );
    };

    const handleLine = (line: string) => {
      cleanup();
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        resume(Effect.succeedSome(parsed.success));
      } else {
        resume(
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
      cleanup();
      resume(Effect.succeedNone);
    };

    input.once("error", handleError);
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
    try: () => NodeFS.fstatSync(fd),
    catch: (error) =>
      new BootstrapFdStatError({
        fd,
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchTags({
      BootstrapFdStatError: (error) =>
        isUnavailableBootstrapFdError(error.cause) ? Effect.succeed(false) : Effect.fail(error),
    }),
  );

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
