// @effect-diagnostics nodeBuiltinImport:off
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
} from "@t3tools/contracts";
import {
  splitWorkspaceResourceChunks,
  validateWorkspaceResourceReadInput,
  validateWorkspaceResourceSaveAbortInput,
  validateWorkspaceResourceSaveBeginInput,
  validateWorkspaceResourceSaveChunkInput,
  validateWorkspaceResourceSaveCommitInput,
  verifyWorkspaceResourceUpload,
  WORKSPACE_RESOURCE_MAX_BYTES,
  WORKSPACE_RESOURCES_API,
  type WorkspaceResourceReadEvent,
  type WorkspaceResourceReason,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata, HostApiProvider } from "@t3tools/extension-runtime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import {
  decodeEditableUtf8,
  replaceEditableFile,
  resolveSafeTarget,
} from "../workspace/textEdits.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.resources", detail });
const isOperationError = Schema.is(ExtensionOperationError);

/**
 * Upload-session hygiene, not contract bounds: the wire caps live in the SDK
 * (8 MiB / 2048 chunks / 8192 units). Sessions hold one reassembled buffer
 * each, so the count cap bounds retained memory; the rolling TTL reclaims
 * uploads the caller abandoned mid-transfer.
 */
const UPLOAD_SESSION_TTL_MS = 5 * 60_000;
const MAX_UPLOAD_SESSIONS = 8;

type UploadSession = {
  readonly uploadId: string;
  readonly relativePath: string;
  readonly expectedRevision: string;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly sha256: string;
  readonly chunks: string[];
  /** The installation that opened the session; chunks/commits from others are unknown-upload. */
  readonly callerId: string;
  /**
   * Scope resolved at begin — commit re-resolves it, never the caller's fresh
   * view context. The broker's per-call authorize checks the *invocation*
   * context's project grant, so chunk/commit must additionally require that
   * context to resolve to this same scope: otherwise an upload begun while a
   * project grant was held could still be committed through any other
   * authorized context after the grant was revoked.
   */
  readonly context: ViewContext;
  readonly cwd: string;
  expiresAt: number;
};

/**
 * Trim a truncated byte prefix back to the last complete UTF-8 sequence so
 * the delivered text is exact — a prefix that ends mid-sequence would either
 * lose the tail (lenient decode) or fail outright (fatal decode). Bytes are
 * never fabricated: the boundary walk only drops a partial trailing sequence.
 */
function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
  // Walk back over trailing continuation bytes to the final sequence's lead.
  let lead = bytes.length - 1;
  while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead -= 1;
  const first = bytes[lead]!;
  const sequenceLength =
    first < 0x80
      ? 1
      : first < 0xc2
        ? 0
        : first < 0xe0
          ? 2
          : first < 0xf0
            ? 3
            : first < 0xf8
              ? 4
              : 0;
  // A lead whose sequence extends past the prefix — or no valid lead at all —
  // is dropped; bytes are never fabricated.
  if (sequenceLength === 0 || lead + sequenceLength > bytes.length) return bytes.subarray(0, lead);
  return bytes;
}

/** Tagged workspace read errors → the contract's named read reasons. */
function readUnavailableReason(cause: unknown): WorkspaceResourceReason {
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause
      ? (cause as { _tag: unknown })._tag
      : undefined;
  if (
    tag === "WorkspacePathOutsideRootError" ||
    tag === "WorkspaceFilePathEscapeError" ||
    tag === "WorkspacePathOutsideWorkspaceError"
  )
    return "outside-workspace";
  if (tag === "WorkspacePathNotFileError") return "not-regular-file";
  if (tag === "WorkspaceFileSystemOperationError") {
    const inner = (cause as { cause?: unknown }).cause;
    const code =
      inner !== null && typeof inner === "object" && "code" in inner
        ? (inner as { code: unknown }).code
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return "not-found";
    return "io-error";
  }
  return "io-error";
}

export type WorkspaceResourcesApiDependencies = Parameters<typeof makeExtensionScopeResolver>[0] & {
  readonly workspace: Pick<WorkspaceFileSystem["Service"], "readFileBytes">;
  readonly entries: Pick<WorkspaceEntries["Service"], "refresh">;
  readonly paths: WorkspacePaths["Service"];
  readonly replaceEditableFile?: typeof replaceEditableFile;
  /** Injectable clock for session TTL tests. */
  readonly now?: () => number;
};

/**
 * Host provider for t3.workspace/resources@1.0.0.
 *
 * `read` follows the native WorkspaceFileSystem resolution (workspace-relative
 * with realpath containment; absolute host paths read in place) and delivers
 * the file as ordered chunks + a terminal sha256 over the delivered bytes,
 * truncated honestly at the contract bound or the caller's `maxBytes`.
 * File-level failures are a single `unavailable` closed frame.
 *
 * `save.*` is the chunked compare-and-swap write direction: sessions are
 * bound to the opening installation and its begin-time scope, chunk order is
 * strict, and commit verifies the declared byte length and digest before the
 * shared serialized replace — which re-checks scope, authority and the abort
 * signal inside the lock immediately before the rename.
 */
export function createWorkspaceResourcesApiProvider(
  dependencies: WorkspaceResourcesApiDependencies,
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const replace = dependencies.replaceEditableFile ?? replaceEditableFile;
  const now = dependencies.now ?? Date.now;
  const uploads = new Map<string, UploadSession>();
  const sweepUploads = (at: number) => {
    for (const [uploadId, session] of uploads)
      if (session.expiresAt <= at) uploads.delete(uploadId);
  };
  const findUpload = (uploadId: string, callerId: string): UploadSession | null => {
    const session = uploads.get(uploadId);
    if (!session || session.callerId !== callerId || session.expiresAt <= now()) {
      if (session && session.expiresAt <= now()) uploads.delete(uploadId);
      return null;
    }
    return session;
  };
  /**
   * The broker authorizes the invocation context per call — for upload
   * methods that is not enough: the session's target was fixed at begin. The
   * invocation context must resolve to the same project/thread identity or
   * the upload is unknown to this scope.
   */
  const sameScope = (session: UploadSession, context: ViewContext) =>
    resolve(context).pipe(
      Effect.map(
        (invocation) =>
          invocation.context.resource.projectId === session.context.resource.projectId &&
          (invocation.context.resource.threadId ?? null) ===
            (session.context.resource.threadId ?? null),
      ),
      Effect.mapError(() => failure("Workspace resources are unavailable for this request.")),
    );

  const authority = (metadata: HostApiInvocationMetadata) =>
    Effect.gen(function* () {
      if (!metadata.assertAuthority)
        return yield* failure("Workspace resource authority is unavailable.");
      const principal = metadata.principal;
      if (!principal || principal.environmentId !== dependencies.environmentId)
        return yield* failure("Workspace resource authority is unavailable.");
      return {
        assertAuthority: metadata.assertAuthority,
        requireScope: (scope: string) =>
          principal.scopes.includes(scope)
            ? Effect.void
            : Effect.fail(
                failure(
                  "Workspace resource request requires the authenticated session scope for this method.",
                ),
              ),
      };
    });

  const invoke = Effect.fn("WorkspaceResourcesApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ) {
    signal.throwIfAborted();
    const auth = yield* authority(metadata);
    if (method === "save.begin") {
      const safe = yield* Effect.try({
        try: () => validateWorkspaceResourceSaveBeginInput(input),
        catch: (cause) =>
          isOperationError(cause) ? cause : failure("Invalid workspace resource save request."),
      });
      const scope = yield* resolve(context).pipe(
        Effect.mapError(() => failure("Workspace resources are unavailable for this request.")),
      );
      yield* auth.requireScope(AuthOrchestrationOperateScope);
      // Preflight the strict write-side path walk so a missing/unsafe target
      // fails by name before any bytes are uploaded; commit re-walks it under
      // the lock anyway, so this cannot widen the authority.
      const preflight = yield* resolveSafeTarget({
        cwd: scope.cwd,
        relativePath: safe.relativePath,
      }).pipe(Effect.result);
      if (preflight._tag === "Failure")
        return {
          kind: "unavailable" as const,
          relativePath: safe.relativePath,
          reason: preflight.failure.reason,
        };
      if (preflight.success.realTargetPath === undefined)
        return {
          kind: "unavailable" as const,
          relativePath: safe.relativePath,
          reason: "not-found" as const,
        };
      sweepUploads(now());
      if (uploads.size >= MAX_UPLOAD_SESSIONS)
        return { kind: "unavailable" as const, reason: "upload-limit" as const };
      const uploadId = NodeCrypto.randomBytes(16).toString("hex");
      uploads.set(uploadId, {
        uploadId,
        relativePath: safe.relativePath,
        expectedRevision: safe.expectedRevision,
        byteLength: safe.byteLength,
        chunkCount: safe.chunkCount,
        sha256: safe.sha256,
        chunks: [],
        callerId: metadata.callerId,
        context: scope.context,
        cwd: scope.cwd,
        expiresAt: now() + UPLOAD_SESSION_TTL_MS,
      });
      return { kind: "session" as const, uploadId };
    }
    if (method === "save.chunk") {
      const safe = yield* Effect.try({
        try: () => validateWorkspaceResourceSaveChunkInput(input),
        catch: (cause) =>
          isOperationError(cause) ? cause : failure("Invalid workspace resource chunk request."),
      });
      yield* auth.requireScope(AuthOrchestrationOperateScope);
      const session = findUpload(safe.uploadId, metadata.callerId);
      if (!session || !(yield* sameScope(session, context)))
        return { kind: "unavailable" as const, reason: "unknown-upload" as const };
      if (safe.chunkIndex >= session.chunkCount)
        return yield* failure("Workspace resource chunk exceeds the declared chunk count.");
      if (safe.chunkIndex !== session.chunks.length)
        return yield* failure("Workspace resource chunks must arrive in chunkIndex order.");
      session.chunks.push(safe.data);
      session.expiresAt = now() + UPLOAD_SESSION_TTL_MS;
      return { kind: "accepted" as const, received: session.chunks.length };
    }
    if (method === "save.abort") {
      const safe = yield* Effect.try({
        try: () => validateWorkspaceResourceSaveAbortInput(input),
        catch: (cause) =>
          isOperationError(cause) ? cause : failure("Invalid workspace resource abort request."),
      });
      yield* auth.requireScope(AuthOrchestrationOperateScope);
      const session = uploads.get(safe.uploadId);
      if (session && session.callerId === metadata.callerId) uploads.delete(safe.uploadId);
      return {};
    }
    if (method === "save.commit") {
      const safe = yield* Effect.try({
        try: () => validateWorkspaceResourceSaveCommitInput(input),
        catch: (cause) =>
          isOperationError(cause) ? cause : failure("Invalid workspace resource commit request."),
      });
      yield* auth.requireScope(AuthOrchestrationOperateScope);
      const session = findUpload(safe.uploadId, metadata.callerId);
      if (!session || !(yield* sameScope(session, context)))
        return { kind: "unavailable" as const, reason: "unknown-upload" as const };
      // One-shot: the session is consumed whether the commit lands, conflicts
      // or fails — a retry must re-open at save.begin.
      uploads.delete(safe.uploadId);
      const integrity = verifyWorkspaceResourceUpload({
        declared: session,
        chunks: session.chunks,
        sha256: (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
      if (integrity !== null)
        return {
          kind: "unavailable" as const,
          relativePath: session.relativePath,
          reason: integrity,
        };
      const scope = yield* resolve(session.context).pipe(
        Effect.mapError(() => failure("Workspace resources are unavailable for this request.")),
      );
      const beforeCommit = async () => {
        const current = await Effect.runPromise(
          resolve(session.context).pipe(
            Effect.mapError(() => failure("Workspace resources are unavailable for this request.")),
          ),
        ).catch(() => {
          throw failure("Workspace resources are unavailable for this request.");
        });
        if (current.cwd !== scope.cwd)
          throw failure("Workspace resources are unavailable for this request.");
        await auth.assertAuthority();
        if (signal.aborted) throw failure("Workspace resource save was aborted before commit.");
      };
      const outcome = yield* replace({
        cwd: scope.cwd,
        relativePath: session.relativePath,
        expectedRevision: session.expectedRevision,
        contents: session.chunks.join(""),
        maxBytes: WORKSPACE_RESOURCE_MAX_BYTES,
        shouldAbort: () => signal.aborted,
        beforeCommit,
      }).pipe(Effect.mapError(() => failure("Workspace resource cannot be accessed.")));
      // A definitive error outcome means no rename landed: report it before
      // the delivery re-checks, which only guard a result the broker hands out.
      if (outcome.outcome === "error")
        return {
          kind: "unavailable" as const,
          relativePath: session.relativePath,
          reason: outcome.reason,
        };
      yield* resolve(session.context).pipe(
        Effect.mapError(() => failure("Workspace resources are unavailable for this request.")),
      );
      yield* Effect.tryPromise({
        try: () => auth.assertAuthority(),
        catch: () => failure("Workspace resource authority is no longer authorized."),
      });
      signal.throwIfAborted();
      if (outcome.outcome === "conflict")
        return { kind: "conflict" as const, relativePath: session.relativePath };
      // Same F5 discipline as text-edits: a post-commit refresh failure is
      // logged, not reported as a failed write.
      yield* dependencies.entries
        .refresh(scope.cwd)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Workspace index refresh failed after resource save", { cause }),
          ),
        );
      return {
        kind: "saved" as const,
        relativePath: session.relativePath,
        revision: outcome.revision,
      };
    }
    return yield* failure("Workspace resources API method is unavailable.");
  });

  return {
    providerId: "host.workspace-resources",
    definition: WORKSPACE_RESOURCES_API,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(
        invoke(method, input, context, signal, metadata).pipe(
          Effect.provideService(WorkspacePaths, dependencies.paths),
        ),
        { signal },
      ),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "read") throw failure("Workspace resource stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure("Workspace resource stream resume is unsupported.");
      const principal = metadata.principal;
      if (
        !principal ||
        principal.environmentId !== dependencies.environmentId ||
        !principal.scopes.includes(AuthOrchestrationReadScope) ||
        !metadata.assertAuthority
      )
        throw failure("Workspace resource authority is unavailable.");
      const assertAuthority = metadata.assertAuthority;
      const safe = (() => {
        try {
          return validateWorkspaceResourceReadInput(input);
        } catch {
          throw failure("Invalid workspace resource read request.");
        }
      })();
      return (async function* (): AsyncGenerator<ApiStreamEvent> {
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        signal.throwIfAborted();
        const scope = await run(resolve(context));
        // The unary discipline stretched over a finite transfer: re-resolve the
        // scope and re-assert authority at each frame boundary so a revoked
        // principal or moved workspace stops the stream mid-flight.
        const guard = async () => {
          signal.throwIfAborted();
          await run(resolve(scope.context));
          await assertAuthority();
        };
        const unavailable = (reason: WorkspaceResourceReason): ApiStreamEvent => ({
          type: "closed" as const,
          value: {
            kind: "unavailable",
            relativePath: safe.relativePath,
            reason,
          } satisfies WorkspaceResourceReadEvent,
        });
        const maxBytes = safe.maxBytes ?? WORKSPACE_RESOURCE_MAX_BYTES;
        let file;
        try {
          file = await run(
            dependencies.workspace.readFileBytes({
              cwd: scope.cwd,
              relativePath: safe.relativePath,
              maxBytes,
            }),
          );
        } catch (cause) {
          yield unavailable(readUnavailableReason(cause));
          return;
        }
        const deliveredBytes = file.truncated ? trimToUtf8Boundary(file.bytes) : file.bytes;
        if (deliveredBytes.includes(0)) {
          yield unavailable("binary");
          return;
        }
        const contents = decodeEditableUtf8(deliveredBytes);
        if (contents === undefined) {
          yield unavailable("invalid-utf8");
          return;
        }
        const chunks = splitWorkspaceResourceChunks(contents);
        // A file that shrank mid-read delivers fewer bytes than stat saw —
        // honest truncation, never a claim of completeness.
        const truncated = file.truncated || deliveredBytes.length < file.byteLength;
        const manifest: WorkspaceResourceReadEvent = {
          kind: "manifest",
          relativePath: file.relativePath,
          byteLength: file.byteLength,
          deliveredByteLength: deliveredBytes.length,
          chunkCount: chunks.length,
          truncated,
        };
        yield { type: "snapshot", value: manifest };
        for (const [chunkIndex, data] of chunks.entries()) {
          await guard();
          yield { type: "data", value: { kind: "chunk", chunkIndex, data } };
        }
        await guard();
        yield {
          type: "data",
          value: {
            kind: "complete",
            sha256: NodeCrypto.createHash("sha256").update(deliveredBytes).digest("hex"),
          } satisfies WorkspaceResourceReadEvent,
        };
      })();
    },
  };
}

export const makeWorkspaceResourcesApiProvider = Effect.fn("WorkspaceResourcesApi.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    return createWorkspaceResourcesApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      workspace: yield* WorkspaceFileSystem,
      entries: yield* WorkspaceEntries,
      paths: yield* WorkspacePaths,
    });
  },
);
