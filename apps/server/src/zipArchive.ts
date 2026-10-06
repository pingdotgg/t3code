import * as Effect from "effect/Effect";
import type * as NodeStream from "node:stream";
import * as Yauzl from "yauzl";

/**
 * Opens a local, already verified ZIP for lazy, one-entry-at-a-time reading.
 * `makeError` turns each failure into the caller's own error type. Close the
 * scope to close the archive.
 */
export const openZipArchive = Effect.fn("zipArchive.open")(function* <E>(
  archivePath: string,
  makeError: (detail: string, cause: unknown) => E,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly zip: Yauzl.ZipFile;
        readonly error: () => E | undefined;
        readonly close: Effect.Effect<void>;
      },
      E
    >((resume) => {
      Yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error || !zip) {
            resume(Effect.fail(makeError("Could not open the verified archive.", error)));
            return;
          }
          let closed = false;
          let archiveError: E | undefined;
          zip.on("close", () => {
            closed = true;
          });
          zip.on("error", (cause: unknown) => {
            archiveError = makeError("The archive could not be read.", cause);
          });
          resume(
            Effect.succeed({
              zip,
              error: () => archiveError,
              close: Effect.callback<void>((finish) => {
                if (closed) {
                  finish(Effect.void);
                  return;
                }
                const onClose = () => {
                  zip.removeListener("error", onError);
                  finish(Effect.void);
                };
                const onError = (cause: unknown) => {
                  zip.removeListener("close", onClose);
                  finish(Effect.die(makeError("Could not close the archive.", cause)));
                };
                zip.once("close", onClose);
                zip.once("error", onError);
                zip.close();
              }),
            }),
          );
        },
      );
    }),
    (opened) => opened.close,
  );

  const next = Effect.callback<Yauzl.Entry | null, E>((resume) => {
    const existingError = opened.error();
    if (existingError) {
      resume(Effect.fail(existingError));
      return;
    }
    const cleanup = () => {
      opened.zip.removeListener("entry", onEntry);
      opened.zip.removeListener("end", onEnd);
      opened.zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(makeError("The archive could not be read.", cause)));
    };
    opened.zip.once("entry", onEntry);
    opened.zip.once("end", onEnd);
    opened.zip.once("error", onError);
    opened.zip.readEntry();
    return Effect.sync(cleanup);
  });

  const streamEntry = (entry: Yauzl.Entry) =>
    Effect.acquireRelease(
      Effect.callback<NodeStream.Readable, E>((resume) => {
        opened.zip.openReadStream(entry, (cause, readable) => {
          resume(
            cause || !readable
              ? Effect.fail(makeError("Could not read an archive member.", cause))
              : Effect.succeed(readable),
          );
        });
      }),
      (readable) =>
        Effect.sync(() => {
          readable.destroy();
        }),
    );
  return { entryCount: opened.zip.entryCount, next, streamEntry };
});
