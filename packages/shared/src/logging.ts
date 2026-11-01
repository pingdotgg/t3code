// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSinkConfigurationError extends Schema.TaggedError<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= ${this.minimum} (received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);

const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxBytes",
        received: options.maxBytes,
        minimum: 1,
      });
    }
    if (options.maxFiles < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxFiles",
        received: options.maxFiles,
        minimum: 1,
      });
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    try {
      NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw new RotatingFileSinkError({
        operation: "initialize",
        filePath: this.filePath,
        cause,
      });
    }
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      NodeFS.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;
    } catch (cause) {
      if (isRotatingFileSinkError(cause)) {
        throw cause;
      }
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "write",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (NodeFS.existsSync(oldest)) {
        NodeFS.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (NodeFS.existsSync(source)) {
          NodeFS.renameSync(source, target);
        }
      }

      if (NodeFS.existsSync(this.filePath)) {
        NodeFS.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "rotate",
          filePath: this.filePath,
          cause,
        });
      }
      this.currentSize = this.readCurrentSize();
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of NodeFS.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffixText = entry.slice(baseName.length + 1);
        const suffix = Number(suffixText);
        if (!Number.isInteger(suffix) || String(suffix) !== suffixText || suffix <= this.maxFiles)
          continue;
        NodeFS.rmSync(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({
          operation: "prune",
          filePath: this.filePath,
          cause,
        });
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return NodeFS.statSync(this.filePath).size;
    } catch (cause) {
      if (isFileNotFoundError(cause)) {
        return 0;
      }
      throw new RotatingFileSinkError({
        operation: "read",
        filePath: this.filePath,
        cause,
      });
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

export const makeAsyncRotatingFileSink = Effect.fnUntraced(function* (
  options: Omit<RotatingFileSinkOptions, "throwOnError">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (options.maxBytes < 1)
    return yield* new RotatingFileSinkConfigurationError({
      option: "maxBytes",
      received: options.maxBytes,
      minimum: 1,
    });
  if (options.maxFiles < 1)
    return yield* new RotatingFileSinkConfigurationError({
      option: "maxFiles",
      received: options.maxFiles,
      minimum: 1,
    });
  const failure = (operation: RotatingFileSinkError["operation"]) => (cause: unknown) =>
    new RotatingFileSinkError({ operation, filePath: options.filePath, cause });
  const directory = path.dirname(options.filePath);
  const basename = path.basename(options.filePath);
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(failure("initialize")));
  yield* Effect.gen(function* () {
    for (const entry of yield* fs.readDirectory(directory)) {
      if (!entry.startsWith(`${basename}.`)) continue;
      const suffixText = entry.slice(basename.length + 1);
      const suffix = Number(suffixText);
      if (!Number.isInteger(suffix) || String(suffix) !== suffixText || suffix <= options.maxFiles)
        continue;
      yield* fs.remove(path.join(directory, entry), { force: true });
    }
  }).pipe(Effect.mapError(failure("prune")));
  const readSize = fs.stat(options.filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(0) : Effect.fail(failure("read")(cause)),
    ),
  );
  let currentSize = yield* readSize;
  const semaphore = yield* Semaphore.make(1);
  const rotate = Effect.gen(function* () {
    yield* fs.remove(`${options.filePath}.${options.maxFiles}`, { force: true });
    for (let index = options.maxFiles - 1; index >= 1; index--) {
      const source = `${options.filePath}.${index}`;
      if (yield* fs.exists(source)) yield* fs.rename(source, `${options.filePath}.${index + 1}`);
    }
    if (yield* fs.exists(options.filePath))
      yield* fs.rename(options.filePath, `${options.filePath}.1`);
    currentSize = 0;
  }).pipe(Effect.mapError(failure("rotate")));
  const write = (chunk: string | Buffer) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          if (buffer.length === 0) return;
          if (currentSize > 0 && currentSize + buffer.length > options.maxBytes) yield* rotate;
          yield* fs
            .writeFile(options.filePath, buffer, { flag: "a" })
            .pipe(Effect.mapError(failure("write")));
          currentSize += buffer.length;
        }).pipe(
          Effect.tapError(() =>
            readSize.pipe(
              Effect.tap((size) =>
                Effect.sync(() => {
                  currentSize = size;
                }),
              ),
              Effect.ignore,
            ),
          ),
        ),
      )
      .pipe(Effect.uninterruptible);
  return { write };
});
