import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

export interface VerifiedFile {
  readonly _tag: "VerifiedFile" | "ArtifactFile";
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
}

export interface ArtifactFile extends VerifiedFile {
  readonly _tag: "ArtifactFile";
  readonly sha256: string;
  readonly cleanup: Effect.Effect<void>;
}

const toError = (message: string, cause: unknown) =>
  new Error(message, { cause });

const isSameIdentity = (
  stat: BigIntStats,
  identity: VerifiedFile["identity"],
) =>
  stat.isFile() &&
  stat.dev.toString() === identity.dev &&
  stat.ino.toString() === identity.ino &&
  stat.size.toString() === identity.size &&
  stat.mtimeNs.toString() === identity.mtimeNs &&
  stat.ctimeNs.toString() === identity.ctimeNs;

const identityFrom = (stat: BigIntStats): VerifiedFile["identity"] => ({
  dev: stat.dev.toString(),
  ino: stat.ino.toString(),
  size: stat.size.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  ctimeNs: stat.ctimeNs.toString(),
});

const validateLimit = (maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Artifact maxBytes must be a positive safe integer.");
  }
};

const validateStat = (
  stat: BigIntStats,
  maxBytes: number,
  description: string,
  allowEmpty: boolean,
) => {
  if (!stat.isFile()) {
    throw new Error(`${description} must be a regular file.`);
  }
  if (!allowEmpty && stat.size <= 0n) {
    throw new Error(`${description} must be non-empty.`);
  }
  if (
    stat.size > BigInt(maxBytes) ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      `${description} exceeds the ${maxBytes} byte upload safety limit.`,
    );
  }
};

async function* readVerifiedChunks(
  artifact: VerifiedFile,
): AsyncGenerator<Uint8Array> {
  const handle = await open(
    artifact.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!isSameIdentity(before, artifact.identity)) {
      throw new Error(
        "Prisma deployment artifact changed after it was validated; rebuild or reselect the artifact before deploying.",
      );
    }

    let remaining = artifact.size;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) {
        throw new Error(
          "Prisma deployment artifact was truncated while it was being read.",
        );
      }
      remaining -= bytesRead;
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    }

    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      trailing,
      0,
      trailing.byteLength,
      null,
    );
    const after = await handle.stat({ bigint: true });
    if (trailingBytes !== 0 || !isSameIdentity(after, artifact.identity)) {
      throw new Error(
        "Prisma deployment artifact changed while it was being read; rebuild or reselect the artifact before deploying.",
      );
    }
  } finally {
    await handle.close();
  }
}

const inspectVerifiedFilePromise = async (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly allowEmpty?: boolean;
    readonly description?: string;
  },
) => {
  validateLimit(maxBytes);
  const description = options?.description ?? "File";
  const inputStat = await lstat(inputPath, { bigint: true });
  if (inputStat.isSymbolicLink()) {
    throw new Error(
      `${description} must not be a symbolic link; provide the regular file directly.`,
    );
  }
  validateStat(inputStat, maxBytes, description, options?.allowEmpty ?? false);
  const canonicalPath = await realpath(inputPath);
  const stat = await lstat(canonicalPath, { bigint: true });
  validateStat(stat, maxBytes, description, options?.allowEmpty ?? false);
  if (!isSameIdentity(stat, identityFrom(inputStat))) {
    throw new Error(
      `${description} changed while it was being validated; retry with a stable file.`,
    );
  }
  return {
    _tag: "VerifiedFile" as const,
    path: canonicalPath,
    size: Number(stat.size),
    mode: Number(stat.mode),
    identity: identityFrom(stat),
  } satisfies VerifiedFile;
};

export const inspectVerifiedFile = (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly allowEmpty?: boolean;
    readonly description?: string;
  },
) =>
  Effect.tryPromise({
    try: () => inspectVerifiedFilePromise(inputPath, maxBytes, options),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : toError("Failed to validate file.", cause),
  });

export const inspectArtifactFile = (
  inputPath: string,
  maxBytes: number,
  options?: {
    readonly cleanup?: Effect.Effect<void>;
    readonly description?: string;
  },
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const description = options?.description ?? "Prisma deployment artifact";
      const verified = await inspectVerifiedFilePromise(inputPath, maxBytes, {
        description,
      });
      const hash = createHash("sha256");
      for await (const chunk of readVerifiedChunks(verified)) {
        if (signal.aborted) {
          throw new Error("Prisma deployment artifact validation was aborted.");
        }
        hash.update(chunk);
      }
      return {
        ...verified,
        _tag: "ArtifactFile" as const,
        sha256: hash.digest("hex"),
        cleanup: options?.cleanup ?? Effect.void,
      } satisfies ArtifactFile;
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : toError("Failed to validate Prisma deployment artifact.", cause),
  });

export const artifactFileStream = (artifact: ArtifactFile) =>
  Stream.fromAsyncIterable(readVerifiedChunks(artifact), (cause) =>
    cause instanceof Error
      ? cause
      : toError("Failed to stream Prisma deployment artifact.", cause),
  );

export const verifiedFileChunks = (file: VerifiedFile) =>
  readVerifiedChunks(file);

export const readArtifactFile = (artifact: ArtifactFile) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(artifact.size);
    let offset = 0;
    yield* Stream.runForEach(artifactFileStream(artifact), (chunk) =>
      Effect.sync(() => {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }),
    );
    if (offset !== artifact.size) {
      return yield* Effect.fail(
        new Error(
          "Prisma deployment artifact length changed while it was being read.",
        ),
      );
    }
    return bytes;
  });
