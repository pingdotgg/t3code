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

interface RotationFileSystem<E> {
  exists(path: string): Effect.Effect<boolean, E>;
  isDirectory(path: string): Effect.Effect<boolean, E>;
  rename(source: string, target: string): Effect.Effect<void, E>;
  remove(path: string): Effect.Effect<void, E>;
  read(path: string): Effect.Effect<string, E>;
  write(path: string, content: string): Effect.Effect<void, E>;
}

const RotationPlan = Schema.fromJsonString(
  Schema.Struct({ oldest: Schema.Finite, backups: Schema.Array(Schema.Finite) }),
);
const decodeRotationPlan = Schema.decodeUnknownEffect(RotationPlan);
const encodeRotationPlan = Schema.encodeEffect(RotationPlan);

const ROTATION_SUFFIX = ".rotating";

export function rotationSidecarBase(fileName: string): string | undefined {
  const index = fileName.lastIndexOf(ROTATION_SUFFIX);
  if (index < 0) return undefined;
  const suffix = fileName.slice(index + ROTATION_SUFFIX.length);
  if (suffix === "" || suffix === ".oldest" || suffix === ".json" || suffix === ".json.tmp") {
    return fileName.slice(0, index);
  }
}

function makeRotation<E>(fs: RotationFileSystem<E>, filePath: string, maxFiles: number) {
  const backup = (index: number) => `${filePath}.${index}`;
  const staged = filePath + ROTATION_SUFFIX;
  const journal = `${staged}.json`;
  const draft = `${journal}.tmp`;
  const parked = `${staged}.oldest`;
  const target = (index: number, oldest: number) => (index === oldest ? parked : backup(index + 1));

  const settle = Effect.gen(function* () {
    if (!(yield* fs.exists(journal))) return true;
    if (!(yield* fs.exists(staged))) {
      // Publication committed. Cleanup may wait, but the parked slot cannot be reused yet.
      return yield* Effect.andThen(fs.remove(parked), fs.remove(journal)).pipe(Effect.isSuccess);
    }
    const { oldest, backups } = yield* decodeRotationPlan(yield* fs.read(journal));
    // Undo in reverse order. An occupied source means that move has not run or was already undone.
    for (const index of [...backups].reverse()) {
      const moved = target(index, oldest);
      if (!(yield* fs.exists(backup(index))) && (yield* fs.exists(moved))) {
        yield* fs.rename(moved, backup(index));
      }
    }
    yield* fs.remove(journal);
    return true;
  });

  const publish = Effect.gen(function* () {
    const backups: number[] = [];
    for (let index = maxFiles; index >= 1; index--) {
      const source = backup(index);
      if (!(yield* fs.exists(source))) continue;
      if (index === maxFiles && (yield* fs.isDirectory(source))) yield* fs.remove(source);
      backups.push(index);
    }
    yield* fs.write(draft, yield* encodeRotationPlan({ oldest: maxFiles, backups }));
    yield* fs.rename(draft, journal);
    for (const index of backups) yield* fs.rename(backup(index), target(index, maxFiles));
    yield* fs.rename(staged, backup(1));
    return yield* settle;
  });

  const restoreActive = Effect.gen(function* () {
    if ((yield* fs.exists(staged)) && !(yield* fs.exists(filePath))) {
      yield* fs.rename(staged, filePath);
    }
  });

  const recover = Effect.gen(function* () {
    if (!(yield* settle)) return false;
    if (!(yield* fs.exists(staged))) return true;
    yield* fs.remove(draft);
    if (yield* fs.exists(filePath)) return yield* publish;
    yield* restoreActive;
    return true;
  });

  const rotate = Effect.gen(function* () {
    if (!(yield* fs.exists(filePath))) return true;
    // A denied active-file rename must leave the backups untouched.
    yield* fs.rename(filePath, staged);
    return yield* publish.pipe(
      Effect.tapError(() =>
        Effect.andThen(settle, Effect.andThen(fs.remove(draft), restoreActive)).pipe(Effect.ignore),
      ),
    );
  });

  return { recover, rotate };
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly rotation: ReturnType<typeof makeRotation<RotatingFileSinkError>>;
  private needsRecovery: boolean;
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
    const run = <A>(operation: () => A) =>
      Effect.try({
        try: operation,
        catch: (cause) =>
          new RotatingFileSinkError({ operation: "rotate", filePath: this.filePath, cause }),
      });
    this.rotation = makeRotation(
      {
        exists: (path) => Effect.sync(() => NodeFS.existsSync(path)),
        isDirectory: (path) => run(() => NodeFS.lstatSync(path).isDirectory()),
        rename: (source, target) => run(() => NodeFS.renameSync(source, target)),
        remove: (path) => run(() => NodeFS.rmSync(path, { force: true })),
        read: (path) => run(() => NodeFS.readFileSync(path, "utf8")),
        write: (path, content) => run(() => NodeFS.writeFileSync(path, content)),
      },
      this.filePath,
      this.maxFiles,
    );
    this.needsRecovery = Effect.runSync(
      this.rotation.recover.pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((ready) => !ready),
      ),
    );
    if (!this.needsRecovery) this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.needsRecovery) {
        if (this.runRotation(this.rotation.recover)) this.pruneOverflowBackups();
        this.currentSize = this.readCurrentSize();
      }
      if (
        !this.needsRecovery &&
        this.currentSize > 0 &&
        this.currentSize + buffer.length > this.maxBytes
      ) {
        this.runRotation(this.rotation.rotate);
        this.currentSize = this.readCurrentSize();
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

  private runRotation(operation: typeof this.rotation.rotate): boolean {
    try {
      const ready = Effect.runSync(operation);
      this.needsRecovery = !ready;
      return ready;
    } catch (cause) {
      this.needsRecovery = true;
      if (this.throwOnError) {
        if (isRotatingFileSinkError(cause)) throw cause;
        throw new RotatingFileSinkError({
          operation: "rotate",
          filePath: this.filePath,
          cause,
        });
      }
      return false;
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
  const rotation = makeRotation(
    {
      exists: fs.exists,
      isDirectory: (path) => fs.lstat(path).pipe(Effect.map((stat) => stat.type === "Directory")),
      rename: fs.rename,
      remove: (path) => fs.remove(path, { force: true }),
      read: fs.readFileString,
      write: fs.writeFileString,
    },
    options.filePath,
    options.maxFiles,
  );
  let needsRecovery = yield* rotation.recover.pipe(
    Effect.orElseSucceed(() => false),
    Effect.map((ready) => !ready),
  );
  const pruneOverflowBackups = Effect.gen(function* () {
    for (const entry of yield* fs.readDirectory(directory)) {
      if (!entry.startsWith(`${basename}.`)) continue;
      const suffixText = entry.slice(basename.length + 1);
      const suffix = Number(suffixText);
      if (!Number.isInteger(suffix) || String(suffix) !== suffixText || suffix <= options.maxFiles)
        continue;
      yield* fs.remove(path.join(directory, entry), { force: true });
    }
  }).pipe(Effect.mapError(failure("prune")));
  if (!needsRecovery) yield* pruneOverflowBackups;
  const readSize = fs.stat(options.filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(0) : Effect.fail(failure("read")(cause)),
    ),
  );
  let currentSize = yield* readSize;
  const semaphore = yield* Semaphore.make(1);
  const runRotation = (operation: typeof rotation.rotate) =>
    operation.pipe(
      Effect.mapError(failure("rotate")),
      Effect.tapError(() =>
        Effect.sync(() => {
          needsRecovery = true;
        }),
      ),
    );
  const write = (chunk: string | Buffer) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          if (buffer.length === 0) return;
          if (needsRecovery) {
            const recovered = yield* runRotation(rotation.recover);
            if (recovered) yield* pruneOverflowBackups;
            currentSize = yield* readSize;
            needsRecovery = !recovered;
          }
          if (!needsRecovery && currentSize > 0 && currentSize + buffer.length > options.maxBytes) {
            needsRecovery = !(yield* runRotation(rotation.rotate));
            currentSize = 0;
          }
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
