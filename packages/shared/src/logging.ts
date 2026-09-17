// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

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
  private compression: Promise<void> | undefined;
  private compressionRequested = false;

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
    this.scheduleCompression();
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
      for (const extension of ["", ".gz"]) {
        NodeFS.rmSync(`${this.withSuffix(this.maxFiles)}${extension}`, { force: true });
        for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
          const source = `${this.withSuffix(index)}${extension}`;
          const target = `${this.withSuffix(index + 1)}${extension}`;
          if (NodeFS.existsSync(source)) NodeFS.renameSync(source, target);
        }
      }

      if (NodeFS.existsSync(this.filePath)) {
        NodeFS.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
      this.scheduleCompression();
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
        const suffix = entry.slice(baseName.length + 1);
        if (/^gzip-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.tmp$/u.test(suffix)) {
          // Interrupted compression leaves its numbered source intact.
          NodeFS.rmSync(NodePath.join(dir, entry), { force: true });
          continue;
        }
        const match = /^([1-9]\d*)(?:\.gz)?$/u.exec(suffix);
        if (!match || Number(match[1]) <= this.maxFiles) continue;
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

  /** Wait for scheduled compression before closing a writer or reading its archives. */
  async flushCompression(): Promise<void> {
    while (this.compression) await this.compression;
  }

  private scheduleCompression(): void {
    if (this.compression) {
      this.compressionRequested = true;
      return;
    }
    this.compressionRequested = false;
    this.compression = Promise.resolve()
      .then(() => this.compressBackups())
      // Compression is best effort. A failure leaves the plain backup available.
      .catch(() => {})
      .finally(() => {
        this.compression = undefined;
        if (this.compressionRequested) this.scheduleCompression();
      });
  }

  private async compressBackups(): Promise<void> {
    const attempted = new Set<string>();
    while (true) {
      let source: { path: string; stat: NodeFS.Stats } | undefined;
      for (let index = this.maxFiles; index >= 1; index -= 1) {
        const path = this.withSuffix(index);
        try {
          const stat = NodeFS.statSync(path);
          const identity = `${stat.dev}:${stat.ino}`;
          if (stat.isFile() && !attempted.has(identity)) {
            attempted.add(identity);
            source = { path, stat };
            break;
          }
        } catch (cause) {
          if (!isFileNotFoundError(cause)) throw cause;
        }
      }
      if (!source) return;

      const temporaryPath = `${this.filePath}.gzip-${NodeCrypto.randomUUID()}.tmp`;
      // Pin the inode through publication, including after the input stream closes.
      // Rotation can rename or evict the backup while gzip runs.
      const descriptor = NodeFS.openSync(source.path, "r");
      try {
        const input = NodeFS.createReadStream(source.path, {
          fd: NodeFS.openSync(source.path, "r"),
        });
        await NodeStreamPromises.pipeline(
          input,
          NodeZlib.createGzip(),
          NodeFS.createWriteStream(temporaryPath, { flags: "wx", mode: source.stat.mode }),
        );
        for (let index = 1; index <= this.maxFiles; index += 1) {
          const path = this.withSuffix(index);
          let stat: NodeFS.Stats;
          try {
            stat = NodeFS.statSync(path);
          } catch (cause) {
            if (isFileNotFoundError(cause)) continue;
            throw cause;
          }
          if (stat.dev !== source.stat.dev || stat.ino !== source.stat.ino) continue;
          // Publishing and removing the source are synchronous with respect to rotation.
          NodeFS.utimesSync(temporaryPath, source.stat.atime, source.stat.mtime);
          NodeFS.renameSync(temporaryPath, `${path}.gz`);
          NodeFS.rmSync(path);
          break;
        }
      } catch {
        // Leave the source intact and retry it on the next rotation.
      } finally {
        NodeFS.closeSync(descriptor);
        NodeFS.rmSync(temporaryPath, { force: true });
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
