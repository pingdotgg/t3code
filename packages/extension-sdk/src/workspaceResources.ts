import { copyJson } from "./contracts.js";
import { defineStreamApi, type TypedApi, type TypedStreamApi } from "./capabilities.js";
import { isTextRevision, validateEditableRelativePath, WORKSPACE_WRITE_TEXT } from "./textEdits.js";

/* ------------------------------------------------------------------------
 * t3.workspace/resources — the large-resource transfer contract (F1 C06).
 *
 * `t3.workspace/read-text` and `t3.workspace/text-edits` are deliberately
 * envelope-sized: a unary result must fit the broker's 64 KiB payload and a
 * snapshot save carries its whole contents inline, so they cap at ~48 KiB /
 * 24 000 bytes. This contract transfers UTF-8 text resources past those
 * bounds the same way `t3.vcs/diff` streams oversized diffs: a finite,
 * digest-verified exchange stretched over ≤64 KiB frames.
 *
 * `read` is a one-shot stream: a `manifest` snapshot announces the file's
 * true byte length, the delivered length and the declared chunk count; `chunk`
 * data frames arrive in strict `chunkIndex` order at ≤8192 UTF-16 units each
 * (surrogate pairs never straddle a boundary, so encoding each chunk
 * separately still reassembles the exact bytes); a terminal `complete` frame
 * carries the SHA-256 over the delivered UTF-8 bytes. A file larger than
 * WORKSPACE_RESOURCE_MAX_BYTES — or than the caller's optional `maxBytes` —
 * is delivered as a UTF-8-boundary prefix with `truncated: true`; the
 * terminal digest then covers the delivered prefix, so truncation is honest
 * but never silently coerced into "the whole file". File-level failures
 * (missing, binary, non-UTF-8, escaped root) arrive as a single `unavailable`
 * closed frame carrying a named reason — never a thrown transport error the
 * consumer has to re-parse. Streams are one-shot: no resume cursor; cancel
 * by abandoning the iterator.
 *
 * `save.*` is the write direction at the same bound, because a >24 KiB edit
 * cannot cross the invoke envelope either: `save.begin` declares the target,
 * the base revision and the complete-contents digest up front and returns an
 * upload session; `save.chunk` appends ≤8192-unit chunks in strict order;
 * `save.commit` reassembles, verifies the declared byte length and digest,
 * then performs the same serialized compare-and-replace as
 * `t3.workspace/text-edits` (per-realpath lock, expected-revision check,
 * O_EXCL same-directory temporary, fsync, pre-commit authority barrier,
 * rename) — at WORKSPACE_RESOURCE_MAX_BYTES instead of the editable
 * checkpoint's bound. `save.abort` discards a session; abandoned sessions
 * expire host-side. The returned `revision` is the written bytes' digest and
 * seeds the next `expectedRevision`.
 *
 * Grants: `read` rides the shared `t3.workspace/resources` read grant this
 * contract was named for (also the `t3.resources/lease` mint grant for
 * workspace bytes — the grant id predates this contract). `save.*` rides
 * `t3.workspace/write-text`: the write checkpoint's grant covers the same
 * trust decision at a larger bound, so no second write capability exists.
 * --------------------------------------------------------------------- */
export const WORKSPACE_RESOURCES = "t3.workspace/resources";

/** UTF-16 units per `chunk` frame / `save.chunk` payload — small enough that JSON escaping can never push a frame past 64 KiB. */
export const WORKSPACE_RESOURCE_CHUNK_UNITS = 8192;
/**
 * Declared chunk-count ceiling. The maximum complete transfer (8 MiB of
 * single-byte text) needs exactly 1024 full chunks; the 2x headroom covers
 * surrogate-pair splits and partially-filled chunks.
 */
export const WORKSPACE_RESOURCE_MAX_CHUNKS = 2048;
/**
 * Complete-transfer ceiling in UTF-8 bytes, shared by `read` delivery and
 * `save` commits. Larger files arrive as an honest truncated prefix on read
 * and are rejected `oversized` on save.
 */
export const WORKSPACE_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;

export type WorkspaceResourcePath = string;
/** Lowercase SHA-256 hex over complete UTF-8 bytes — file revision and content digest share one format. */
export type WorkspaceResourceDigest = string;

/**
 * Named failure vocabulary. `read` emits only file-state reasons (never
 * `oversized` — an oversized read is a truncated delivery, not a failure, and
 * never `unsafe-path` — the read follows the native in-root realpath
 * resolution). `save.*` adds the upload-session reasons and emits
 * `unsafe-path`/`oversized` from the strict write-side path walk.
 */
export type WorkspaceResourceReason =
  | "not-found"
  | "not-regular-file"
  | "binary"
  | "invalid-utf8"
  | "oversized"
  | "outside-workspace"
  | "unsafe-path"
  | "changed-during-read"
  | "aborted"
  | "io-error"
  | "unknown-upload"
  | "upload-limit"
  | "upload-incomplete"
  | "digest-mismatch";

export const WORKSPACE_RESOURCE_REASONS: readonly WorkspaceResourceReason[] = [
  "not-found",
  "not-regular-file",
  "binary",
  "invalid-utf8",
  "oversized",
  "outside-workspace",
  "unsafe-path",
  "changed-during-read",
  "aborted",
  "io-error",
  "unknown-upload",
  "upload-limit",
  "upload-incomplete",
  "digest-mismatch",
];

export type WorkspaceResourceReadInput = {
  readonly relativePath: WorkspaceResourcePath;
  /**
   * Optional caller bound in UTF-8 bytes (1..WORKSPACE_RESOURCE_MAX_BYTES).
   * The preview pane asks for the native 1 MiB head; the editor omits it for
   * the full transfer. Beyond the bound the file is delivered truncated.
   */
  readonly maxBytes?: number;
};

export type WorkspaceResourceReadManifest = {
  readonly kind: "manifest";
  readonly relativePath: WorkspaceResourcePath;
  /** True file size on disk at read time. */
  readonly byteLength: number;
  /** UTF-8 bytes this stream delivers — `byteLength` unless truncated. */
  readonly deliveredByteLength: number;
  readonly chunkCount: number;
  readonly truncated: boolean;
};
export type WorkspaceResourceReadChunk = {
  readonly kind: "chunk";
  readonly chunkIndex: number;
  readonly data: string;
};
export type WorkspaceResourceReadComplete = {
  readonly kind: "complete";
  /** SHA-256 over the delivered UTF-8 bytes — the file revision when `truncated` is false. */
  readonly sha256: WorkspaceResourceDigest;
};
export type WorkspaceResourceReadUnavailable = {
  readonly kind: "unavailable";
  readonly relativePath: WorkspaceResourcePath;
  readonly reason: WorkspaceResourceReason;
};
export type WorkspaceResourceReadEvent =
  | WorkspaceResourceReadManifest
  | WorkspaceResourceReadChunk
  | WorkspaceResourceReadComplete
  | WorkspaceResourceReadUnavailable;

export type WorkspaceResourceSaveBeginInput = {
  readonly relativePath: WorkspaceResourcePath;
  /** SHA-256 of the file's complete current bytes — the base this save swaps against. */
  readonly expectedRevision: WorkspaceResourceDigest;
  /** UTF-8 byte length of the complete new contents. */
  readonly byteLength: number;
  readonly chunkCount: number;
  /** SHA-256 of the complete new contents' UTF-8 bytes. */
  readonly sha256: WorkspaceResourceDigest;
};
export type WorkspaceResourceSaveSession = {
  readonly kind: "session";
  readonly uploadId: string;
};
export type WorkspaceResourceSaveUnavailable = {
  readonly kind: "unavailable";
  /** Present for path-bound failures; session-level reasons (unknown-upload, upload-limit) omit it. */
  readonly relativePath?: WorkspaceResourcePath;
  readonly reason: WorkspaceResourceReason;
};
export type WorkspaceResourceSaveBeginResult =
  | WorkspaceResourceSaveSession
  | WorkspaceResourceSaveUnavailable;

export type WorkspaceResourceSaveChunkInput = {
  readonly uploadId: string;
  readonly chunkIndex: number;
  readonly data: string;
};
export type WorkspaceResourceSaveChunkResult =
  | { readonly kind: "accepted"; readonly received: number }
  | { readonly kind: "unavailable"; readonly reason: WorkspaceResourceReason };

export type WorkspaceResourceSaveCommitInput = {
  readonly uploadId: string;
};
export type WorkspaceResourceSaveCommitResult =
  | {
      readonly kind: "saved";
      readonly relativePath: WorkspaceResourcePath;
      readonly revision: WorkspaceResourceDigest;
    }
  | { readonly kind: "conflict"; readonly relativePath: WorkspaceResourcePath }
  | WorkspaceResourceSaveUnavailable;

export type WorkspaceResourceSaveAbortInput = {
  readonly uploadId: string;
};
export type WorkspaceResourceSaveAbortResult = Record<string, never>;

/**
 * The shared chunker host producers and client uploaders both use: fixed-unit
 * slices that never split a UTF-16 surrogate pair, so per-chunk UTF-8
 * re-encodes concatenate to the exact delivered bytes.
 */
export function splitWorkspaceResourceChunks(data: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + WORKSPACE_RESOURCE_CHUNK_UNITS, data.length);
    if (end < data.length) {
      const previous = data.charCodeAt(end - 1);
      const next = data.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

const resourcePath = { type: "string", minLength: 1, maxLength: 512 };
const resourceDigest = {
  type: "string",
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
};
const resourceReason = { enum: WORKSPACE_RESOURCE_REASONS };
const uploadId = { type: "string", minLength: 1, maxLength: 128 };
const resourceByteLength = {
  type: "integer",
  minimum: 0,
  maximum: WORKSPACE_RESOURCE_MAX_BYTES,
};
const resourceChunkCount = {
  type: "integer",
  minimum: 0,
  maximum: WORKSPACE_RESOURCE_MAX_CHUNKS,
};
const saveUnavailableOutput = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "reason"],
  properties: {
    kind: { const: "unavailable" },
    relativePath: resourcePath,
    reason: resourceReason,
  },
} as const;

export const workspaceResourcesApi: TypedApi<{
  "save.begin": {
    input: WorkspaceResourceSaveBeginInput;
    output: WorkspaceResourceSaveBeginResult;
  };
  "save.chunk": {
    input: WorkspaceResourceSaveChunkInput;
    output: WorkspaceResourceSaveChunkResult;
  };
  "save.commit": {
    input: WorkspaceResourceSaveCommitInput;
    output: WorkspaceResourceSaveCommitResult;
  };
  "save.abort": {
    input: WorkspaceResourceSaveAbortInput;
    output: WorkspaceResourceSaveAbortResult;
  };
}> &
  TypedStreamApi<{
    read: { input: WorkspaceResourceReadInput; event: WorkspaceResourceReadEvent };
  }> = defineStreamApi<{
  read: { input: WorkspaceResourceReadInput; event: WorkspaceResourceReadEvent };
}>({
  id: WORKSPACE_RESOURCES,
  version: "1.0.0",
  methods: [
    {
      name: "save.begin",
      effect: "write",
      requiredGrants: [WORKSPACE_WRITE_TEXT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath", "expectedRevision", "byteLength", "chunkCount", "sha256"],
        properties: {
          relativePath: resourcePath,
          expectedRevision: resourceDigest,
          byteLength: resourceByteLength,
          chunkCount: resourceChunkCount,
          sha256: resourceDigest,
        },
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "uploadId"],
            properties: { kind: { const: "session" }, uploadId },
          },
          saveUnavailableOutput,
        ],
      },
    },
    {
      name: "save.chunk",
      effect: "write",
      requiredGrants: [WORKSPACE_WRITE_TEXT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uploadId", "chunkIndex", "data"],
        properties: {
          uploadId,
          chunkIndex: {
            type: "integer",
            minimum: 0,
            maximum: WORKSPACE_RESOURCE_MAX_CHUNKS - 1,
          },
          data: { type: "string", maxLength: WORKSPACE_RESOURCE_CHUNK_UNITS },
        },
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "received"],
            properties: {
              kind: { const: "accepted" },
              received: resourceChunkCount,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: { kind: { const: "unavailable" }, reason: resourceReason },
          },
        ],
      },
    },
    {
      name: "save.commit",
      effect: "write",
      requiredGrants: [WORKSPACE_WRITE_TEXT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uploadId"],
        properties: { uploadId },
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "relativePath", "revision"],
            properties: {
              kind: { const: "saved" },
              relativePath: resourcePath,
              revision: resourceDigest,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "relativePath"],
            properties: { kind: { const: "conflict" }, relativePath: resourcePath },
          },
          saveUnavailableOutput,
        ],
      },
    },
    {
      name: "save.abort",
      effect: "write",
      requiredGrants: [WORKSPACE_WRITE_TEXT],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uploadId"],
        properties: { uploadId },
      },
      outputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  ],
  streams: [
    {
      name: "read",
      requiredGrants: [WORKSPACE_RESOURCES],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: {
          relativePath: resourcePath,
          maxBytes: { type: "integer", minimum: 1, maximum: WORKSPACE_RESOURCE_MAX_BYTES },
        },
      },
      eventSchema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "relativePath",
              "byteLength",
              "deliveredByteLength",
              "chunkCount",
              "truncated",
            ],
            properties: {
              kind: { const: "manifest" },
              relativePath: resourcePath,
              byteLength: { type: "integer", minimum: 0 },
              deliveredByteLength: resourceByteLength,
              chunkCount: resourceChunkCount,
              truncated: { type: "boolean" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "chunkIndex", "data"],
            properties: {
              kind: { const: "chunk" },
              chunkIndex: {
                type: "integer",
                minimum: 0,
                maximum: WORKSPACE_RESOURCE_MAX_CHUNKS - 1,
              },
              data: { type: "string", maxLength: WORKSPACE_RESOURCE_CHUNK_UNITS },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "sha256"],
            properties: { kind: { const: "complete" }, sha256: resourceDigest },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "relativePath", "reason"],
            properties: {
              kind: { const: "unavailable" },
              relativePath: resourcePath,
              reason: resourceReason,
            },
          },
        ],
      },
    },
  ],
});
export const WORKSPACE_RESOURCES_API = workspaceResourcesApi.definition;

const invalid = (what: string) => new Error(`Invalid workspace resource ${what}`);

function requireObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = copyJson(value);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => key in input)
  )
    throw invalid("request");
  return input as Record<string, unknown>;
}

function validateUploadId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw invalid("upload id");
  return value;
}

function validateChunkIndex(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= WORKSPACE_RESOURCE_MAX_CHUNKS
  )
    throw invalid("chunk index");
  return value;
}

function validateChunkData(value: unknown): string {
  if (typeof value !== "string" || value.length > WORKSPACE_RESOURCE_CHUNK_UNITS)
    throw invalid("chunk data");
  return value;
}

export function validateWorkspaceResourceReadInput(value: unknown): WorkspaceResourceReadInput {
  const input = copyJson(value) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("request");
  const keys = Object.keys(input);
  if (!keys.every((key) => key === "relativePath" || key === "maxBytes")) throw invalid("request");
  const relativePath = validateEditableRelativePath(input.relativePath);
  if (input.maxBytes === undefined) return { relativePath };
  if (
    typeof input.maxBytes !== "number" ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes > WORKSPACE_RESOURCE_MAX_BYTES
  )
    throw invalid("maxBytes");
  return { relativePath, maxBytes: input.maxBytes };
}

export function validateWorkspaceResourceSaveBeginInput(
  value: unknown,
): WorkspaceResourceSaveBeginInput {
  const input = requireObject(value, [
    "relativePath",
    "expectedRevision",
    "byteLength",
    "chunkCount",
    "sha256",
  ]);
  if (!isTextRevision(input.expectedRevision) || !isTextRevision(input.sha256))
    throw invalid("digest");
  if (
    typeof input.byteLength !== "number" ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength > WORKSPACE_RESOURCE_MAX_BYTES
  )
    throw invalid("byte length");
  if (
    typeof input.chunkCount !== "number" ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount < 0 ||
    input.chunkCount > WORKSPACE_RESOURCE_MAX_CHUNKS
  )
    throw invalid("chunk count");
  // The declared chunk count must be able to carry the declared bytes: one
  // UTF-16 unit encodes at most 3 UTF-8 bytes (BMP), so byteLength can never
  // exceed chunkCount * 8192 * 3 — and 0-byte saves need no chunks at all.
  if (input.byteLength > input.chunkCount * WORKSPACE_RESOURCE_CHUNK_UNITS * 3)
    throw invalid("chunk count");
  if (input.byteLength === 0 && input.chunkCount !== 0) throw invalid("chunk count");
  return {
    relativePath: validateEditableRelativePath(input.relativePath),
    expectedRevision: input.expectedRevision,
    byteLength: input.byteLength,
    chunkCount: input.chunkCount,
    sha256: input.sha256,
  };
}

export function validateWorkspaceResourceSaveChunkInput(
  value: unknown,
): WorkspaceResourceSaveChunkInput {
  const input = requireObject(value, ["uploadId", "chunkIndex", "data"]);
  return {
    uploadId: validateUploadId(input.uploadId),
    chunkIndex: validateChunkIndex(input.chunkIndex),
    data: validateChunkData(input.data),
  };
}

export function validateWorkspaceResourceSaveCommitInput(
  value: unknown,
): WorkspaceResourceSaveCommitInput {
  const input = requireObject(value, ["uploadId"]);
  return { uploadId: validateUploadId(input.uploadId) };
}

export function validateWorkspaceResourceSaveAbortInput(
  value: unknown,
): WorkspaceResourceSaveAbortInput {
  const input = requireObject(value, ["uploadId"]);
  return { uploadId: validateUploadId(input.uploadId) };
}

/**
 * Reassembled-upload integrity check: strict chunk count, exact UTF-8 byte
 * length and the declared contents digest — the same triple verification the
 * `read` consumer performs before text may reach an editor buffer.
 */
export function verifyWorkspaceResourceUpload(input: {
  readonly declared: Pick<WorkspaceResourceSaveBeginInput, "byteLength" | "chunkCount" | "sha256">;
  readonly chunks: readonly string[];
  readonly sha256: (data: Uint8Array) => WorkspaceResourceDigest;
}): WorkspaceResourceReason | null {
  if (input.chunks.length !== input.declared.chunkCount) return "upload-incomplete";
  const contents = input.chunks.join("");
  const bytes = new TextEncoder().encode(contents);
  if (bytes.length !== input.declared.byteLength) return "digest-mismatch";
  if (input.sha256(bytes) !== input.declared.sha256) return "digest-mismatch";
  return null;
}
