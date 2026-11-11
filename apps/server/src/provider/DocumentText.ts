// @effect-diagnostics nodeBuiltinImport:off -- the isolated parser process is an external runtime boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

const extensions = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb"]);

class DocumentTextError extends Schema.TaggedError<DocumentTextError>()("DocumentTextError", {
  operation: Schema.Literal("extract"),
  path: Schema.String,
  extension: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} ${this.extension} document text.`;
  }
}

export const resolveExtractedTextPath = Effect.fn("DocumentText.resolveExtractedTextPath")(
  function* (path: string) {
    const extension = path.split(".").at(-1)?.toLowerCase();
    if (!extension || !extensions.has(extension)) return;
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path + ".txt").pipe(
      Effect.map((exists) => (exists ? path + ".txt" : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  },
);

export class DocumentText extends Context.Service<
  DocumentText,
  {
    readonly ensure: (path: string) => Effect.Effect<string | undefined>;
  }
>()("t3/provider/DocumentText") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);
  const failed = new Map<string, number>();
  // In a bundle import.meta.url is bin.mjs; development and tests use this source module.
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  const extract = Effect.fn("DocumentText.extract")(function* (path: string, extension: string) {
    const sidecar = `${path}.txt`;
    if (yield* fs.exists(sidecar)) return sidecar;
    if ((failed.get(path) ?? 0) > clock.currentTimeMillisUnsafe()) return;
    const info = yield* fs.stat(path);
    if (Number(info.size) > 16 * 1024 * 1024) return;
    const content = yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            executable,
            [...(isExecutable ? [] : [entry]), "__document-text", path, `.${extension}`],
            {
              signal,
              timeout: 15_000,
              maxBuffer: 4 * 1024 * 1024 + 1024,
              encoding: "utf8",
              windowsHide: true,
              env: {
                ...environment,
                ELECTRON_RUN_AS_NODE: "1",
                NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --max-old-space-size=192`,
              },
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        }),
      catch: (cause) => new DocumentTextError({ operation: "extract", path, extension, cause }),
    }).pipe(
      Effect.tapError(({ cause }) => {
        if (failed.size >= 1024) failed.delete(failed.keys().next().value!);
        failed.set(
          path,
          cause instanceof Error && "code" in cause && cause.code === 2
            ? Infinity
            : clock.currentTimeMillisUnsafe() + 1_000,
        );
        return Effect.logWarning("Document text extraction failed.", { extension });
      }),
    );
    const pending = `${sidecar}.part`;
    yield* fs
      .writeFileString(pending, content)
      .pipe(
        Effect.andThen(fs.rename(pending, sidecar)),
        Effect.ensuring(fs.remove(pending, { force: true }).pipe(Effect.ignore)),
        Effect.uninterruptible,
      );
    return sidecar;
  }, lock.withPermits(1));
  const ensure = Effect.fn("DocumentText.ensure")(
    function* (path: string) {
      const extension = path.split(".").at(-1)?.toLowerCase();
      if (!extension || !extensions.has(extension)) return;
      const sidecar = `${path}.txt`;
      if (yield* fs.exists(sidecar)) return sidecar;
      return yield* extract(path, extension);
    },
    Effect.orElseSucceed(() => undefined),
  );
  return DocumentText.of({ ensure });
});

export const layer = Layer.effect(DocumentText, make);
