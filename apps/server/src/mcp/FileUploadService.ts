// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off instanceOfSchema:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Readable, Transform } from "node:stream";

import {
  FileUploadMimeTypeNotAllowedError,
  FileUploadPathValidationError,
  FileUploadResult,
  FileUploadSizeLimitError,
  FileUploadStorageConfigurationError,
  FileUploadStorageError,
  FileUploadWorkspaceContextNotFoundError,
  FileUploadWorkspaceResolutionError,
  type FileUploadInput,
  type FileUploadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_NAME_BYTES = 240;
const MAX_UPLOAD_CONCURRENCY = 2;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const ALLOWED_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/3gpp",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
]);

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/3gpp": "3gp",
  "video/mp4": "mp4",
  "video/mpeg": "mpeg",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
};

interface StorageConfig {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly publicBaseUrl: URL;
  readonly maxBytes: number;
}

interface FileInspection {
  readonly handle: NodeFSP.FileHandle;
  readonly size: number;
  readonly probe: Buffer;
  readonly relativePath: string;
}

type InspectionFailure = {
  readonly kind: "outside-workspace" | "symlink" | "not-a-file" | "unreadable";
};

class UploadStreamError extends Error {
  readonly kind: "size-changed" | "read-failed";

  constructor(kind: "size-changed" | "read-failed") {
    super(kind);
    this.kind = kind;
  }
}

function parseMaxBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function readStorageConfig(): StorageConfig | FileUploadStorageConfigurationError {
  const endpointValue = process.env.T3CODE_FILE_UPLOAD_S3_ENDPOINT?.trim() ?? "";
  const bucket = process.env.T3CODE_FILE_UPLOAD_S3_BUCKET?.trim() ?? "";
  const accessKeyId = process.env.T3CODE_FILE_UPLOAD_S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.T3CODE_FILE_UPLOAD_S3_SECRET_ACCESS_KEY?.trim() ?? "";
  const publicBaseUrlValue = process.env.T3CODE_FILE_UPLOAD_PUBLIC_BASE_URL?.trim() ?? "";
  const missing = [
    endpointValue ? undefined : "T3CODE_FILE_UPLOAD_S3_ENDPOINT",
    bucket ? undefined : "T3CODE_FILE_UPLOAD_S3_BUCKET",
    accessKeyId ? undefined : "T3CODE_FILE_UPLOAD_S3_ACCESS_KEY_ID",
    secretAccessKey ? undefined : "T3CODE_FILE_UPLOAD_S3_SECRET_ACCESS_KEY",
    publicBaseUrlValue ? undefined : "T3CODE_FILE_UPLOAD_PUBLIC_BASE_URL",
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    return new FileUploadStorageConfigurationError({ missing });
  }

  let endpoint: URL;
  let publicBaseUrl: URL;
  try {
    endpoint = new URL(endpointValue);
    publicBaseUrl = new URL(publicBaseUrlValue);
  } catch {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "storage endpoint or public base URL",
    });
  }

  if (endpoint.protocol !== "https:" || publicBaseUrl.protocol !== "https:") {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "storage endpoint and public base URL must use HTTPS",
    });
  }
  if (endpoint.host === publicBaseUrl.host) {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "T3CODE_FILE_UPLOAD_PUBLIC_BASE_URL must use a separate public hostname",
    });
  }
  if (endpoint.search || endpoint.hash || publicBaseUrl.search || publicBaseUrl.hash) {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "storage endpoint and public base URL must not contain query parameters",
    });
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "T3CODE_FILE_UPLOAD_S3_BUCKET",
    });
  }

  const maxBytes = parseMaxBytes(process.env.T3CODE_FILE_UPLOAD_MAX_BYTES);
  if (maxBytes === 0) {
    return new FileUploadStorageConfigurationError({
      missing: [],
      invalid: "T3CODE_FILE_UPLOAD_MAX_BYTES",
    });
  }

  return {
    endpoint,
    region: process.env.T3CODE_FILE_UPLOAD_S3_REGION?.trim() || "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    maxBytes,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function sha256Hex(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return NodeCrypto.createHmac("sha256", key).update(value).digest();
}

function encodeUriSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function makeObjectPath(config: StorageConfig, key: string): string {
  const endpointPath = config.endpoint.pathname.replace(/\/+$/, "");
  return `${endpointPath}/${encodeUriSegment(config.bucket)}/${key
    .split("/")
    .map(encodeUriSegment)
    .join("/")}`;
}

function signPutRequest(input: {
  readonly config: StorageConfig;
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly now: Date;
}): { readonly url: URL; readonly headers: Record<string, string> } {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const pathname = makeObjectPath(input.config, input.key);
  const url = new URL(input.config.endpoint.href);
  url.pathname = pathname;
  const headers: Record<string, string> = {
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(input.size),
    "content-type": input.contentType,
    host: url.host,
    "if-none-match": "*",
    "x-amz-content-sha256": UNSIGNED_PAYLOAD,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${input.config.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.config.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = bytesToHex(hmac(signingKey, stringToSign));
  return {
    url,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function detectMediaType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    const riffType = buffer.subarray(8, 12).toString("ascii");
    if (riffType === "WEBP") return "image/webp";
    if (riffType === "AVI ") return "video/x-msvideo";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return "image/heif";
    }
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "3gp4" || brand === "3gp5" || brand === "3gp6") return "video/3gpp";
    if (
      brand.startsWith("mp4") ||
      brand.startsWith("iso") ||
      brand === "M4V " ||
      brand === "dash"
    ) {
      return "video/mp4";
    }
    return undefined;
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) {
    const probeText = buffer.toString("ascii");
    return probeText.includes("webm") ? "video/webm" : "video/x-matroska";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("000001ba", "hex"))) {
    return "video/mpeg";
  }
  return undefined;
}

function sanitizeName(input: string, fallback: string, contentType: string): string {
  const candidate = NodePath.basename(input || fallback).replace(/[\u0000-\u001f\u007f]/g, "");
  const sanitized = candidate
    .replace(/[\\/]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_UPLOAD_NAME_BYTES);
  if (sanitized.length > 0) return sanitized;
  return `file.${CONTENT_TYPE_EXTENSIONS[contentType] ?? "bin"}`;
}

async function inspectFile(
  absolutePath: string,
  workspaceRoot: string,
  relativePath: string,
): Promise<FileInspection | InspectionFailure> {
  let rootRealPath: string;
  let fileRealPath: string;
  try {
    [rootRealPath, fileRealPath] = await Promise.all([
      NodeFSP.realpath(workspaceRoot),
      NodeFSP.realpath(absolutePath),
    ]);
  } catch {
    return { kind: "unreadable" };
  }
  const relativeRealPath = NodePath.relative(rootRealPath, fileRealPath);
  if (
    relativeRealPath.length === 0 ||
    relativeRealPath === ".." ||
    relativeRealPath.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relativeRealPath)
  ) {
    return { kind: "outside-workspace" };
  }

  let handle: NodeFSP.FileHandle | undefined;
  try {
    const linkStat = await NodeFSP.lstat(absolutePath);
    if (linkStat.isSymbolicLink()) return { kind: "symlink" };
    const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0;
    handle = await NodeFSP.open(absolutePath, NodeFS.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return { kind: "not-a-file" };
    }
    const probeBuffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(probeBuffer, 0, probeBuffer.length, 0);
    return {
      handle,
      size: stat.size,
      probe: probeBuffer.subarray(0, bytesRead),
      relativePath,
    };
  } catch {
    await handle?.close().catch(() => undefined);
    return { kind: "unreadable" };
  }
}

async function putObject(input: {
  readonly config: StorageConfig;
  readonly key: string;
  readonly handle: NodeFSP.FileHandle;
  readonly size: number;
  readonly contentType: string;
}): Promise<string> {
  const request = signPutRequest({
    config: input.config,
    key: input.key,
    contentType: input.contentType,
    size: input.size,
    now: new Date(),
  });
  const hash = NodeCrypto.createHash("sha256");
  let bytesRead = 0;
  const source = input.handle.createReadStream({ autoClose: false });
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > input.size) {
        callback(new UploadStreamError("size-changed"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(bytesRead === input.size ? undefined : new UploadStreamError("size-changed"));
    },
  });
  try {
    const response = await fetch(request.url, {
      method: "PUT",
      headers: request.headers,
      body: Readable.toWeb(source.pipe(hashing)) as unknown as RequestInit["body"],
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      throw new FileUploadStorageError({ operation: "put", status: response.status });
    }
    return hash.digest("hex");
  } catch (cause) {
    if (cause instanceof FileUploadStorageError) throw cause;
    throw new FileUploadStorageError({ operation: "put" });
  } finally {
    await input.handle.close().catch(() => undefined);
  }
}

function publicUrl(config: StorageConfig, key: string): string {
  const base = config.publicBaseUrl.href.replace(/\/+$/, "");
  return `${base}/${key.split("/").map(encodeUriSegment).join("/")}`;
}

export interface FileUploadServiceShape {
  readonly upload: (
    input: FileUploadInput,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<FileUploadResult, FileUploadError>;
}

export class FileUploadService extends Context.Service<FileUploadService, FileUploadServiceShape>()(
  "t3/mcp/FileUploadService",
) {}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const uploadSemaphore = yield* Semaphore.make(MAX_UPLOAD_CONCURRENCY);

  const upload: FileUploadServiceShape["upload"] = Effect.fn("FileUploadService.upload")(
    function* (input, scope) {
      const thread = yield* projectionSnapshotQuery.getThreadShellById(scope.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new FileUploadWorkspaceResolutionError({
              environmentId: scope.environmentId,
              threadId: scope.threadId,
              providerSessionId: scope.providerSessionId,
              providerInstanceId: scope.providerInstanceId,
              cause,
            }),
        ),
      );
      if (Option.isNone(thread)) {
        return yield* new FileUploadWorkspaceContextNotFoundError({
          environmentId: scope.environmentId,
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        });
      }
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(thread.value.projectId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new FileUploadWorkspaceResolutionError({
                environmentId: scope.environmentId,
                threadId: scope.threadId,
                providerSessionId: scope.providerSessionId,
                providerInstanceId: scope.providerInstanceId,
                cause,
              }),
          ),
        );
      if (Option.isNone(project)) {
        return yield* new FileUploadWorkspaceContextNotFoundError({
          environmentId: scope.environmentId,
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        });
      }

      const workspaceRoot = thread.value.worktreePath ?? project.value.workspaceRoot;
      const normalizedPath = input.path.trim();
      const hasTraversalSegment = normalizedPath.split(/[\\/]/).some((segment) => segment === "..");
      if (NodePath.posix.isAbsolute(normalizedPath) || NodePath.win32.isAbsolute(normalizedPath)) {
        return yield* new FileUploadPathValidationError({
          path: input.path,
          reason: "absolute-path",
        });
      }
      if (hasTraversalSegment) {
        return yield* new FileUploadPathValidationError({
          path: input.path,
          reason: "path-traversal",
        });
      }

      const normalizedRoot = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new FileUploadWorkspaceResolutionError({
              environmentId: scope.environmentId,
              threadId: scope.threadId,
              providerSessionId: scope.providerSessionId,
              providerInstanceId: scope.providerInstanceId,
              cause,
            }),
        ),
      );
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: normalizedRoot,
          relativePath: normalizedPath,
        })
        .pipe(
          Effect.mapError(
            () =>
              new FileUploadPathValidationError({
                path: input.path,
                reason: "outside-workspace",
              }),
          ),
        );
      const inspection = yield* Effect.tryPromise({
        try: () => inspectFile(resolved.absolutePath, normalizedRoot, resolved.relativePath),
        catch: () =>
          new FileUploadPathValidationError({
            path: input.path,
            reason: "unreadable",
          }),
      });
      if ("kind" in inspection) {
        return yield* new FileUploadPathValidationError({
          path: input.path,
          reason: inspection.kind,
        });
      }

      const config = readStorageConfig();
      if (config instanceof FileUploadStorageConfigurationError) {
        yield* Effect.promise(() => inspection.handle.close().catch(() => undefined));
        return yield* config;
      }
      if (inspection.size > config.maxBytes) {
        yield* Effect.promise(() => inspection.handle.close().catch(() => undefined));
        return yield* new FileUploadSizeLimitError({
          path: input.path,
          size: inspection.size,
          maxBytes: config.maxBytes,
        });
      }

      const detectedContentType = detectMediaType(inspection.probe);
      if (detectedContentType === undefined || !ALLOWED_CONTENT_TYPES.has(detectedContentType)) {
        yield* Effect.promise(() => inspection.handle.close().catch(() => undefined));
        return yield* new FileUploadMimeTypeNotAllowedError({
          path: input.path,
          detectedContentType: detectedContentType ?? "application/octet-stream",
          ...(input.contentType === undefined ? {} : { requestedContentType: input.contentType }),
        });
      }
      const requestedContentType = input.contentType?.trim().toLowerCase();
      if (requestedContentType !== undefined && requestedContentType !== detectedContentType) {
        yield* Effect.promise(() => inspection.handle.close().catch(() => undefined));
        return yield* new FileUploadMimeTypeNotAllowedError({
          path: input.path,
          detectedContentType,
          requestedContentType,
        });
      }

      const safeName = sanitizeName(
        input.name ?? "",
        NodePath.basename(inspection.relativePath),
        detectedContentType,
      );
      const key = `files/${NodeCrypto.randomUUID()}/${safeName}`;
      const sha256 = yield* uploadSemaphore.withPermit(
        Effect.tryPromise({
          try: () =>
            putObject({
              config,
              key,
              handle: inspection.handle,
              size: inspection.size,
              contentType: detectedContentType,
            }),
          catch: (cause) =>
            cause instanceof FileUploadStorageError
              ? cause
              : new FileUploadStorageError({ operation: "put" }),
        }),
      );
      return FileUploadResult.make({
        url: publicUrl(config, key),
        name: safeName,
        contentType: detectedContentType,
        size: inspection.size,
        sha256,
      });
    },
  );

  return { upload } satisfies FileUploadServiceShape;
});

export const layer = Layer.effect(FileUploadService, make);

export const __testing = {
  detectMediaType,
  sanitizeName,
  signPutRequest,
};
