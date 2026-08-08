import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ENVIRONMENT_HANDOFF_PART_CHUNK_BYTES,
  EnvironmentHttpApi,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import * as ThreadHandoffService from "./ThreadHandoffService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket — gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const threadHandoff = yield* ThreadHandoffService.ThreadHandoffService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Only the requested window of a staged part is ever read: parts approach
    // the payload ceiling, so reading whole files per request would allocate a
    // gigabyte at a time.
    const readWindow = (target: string, offset: number, length: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(target, { flag: "r" });
          yield* file.seek(offset, "start");
          const buffer = new Uint8Array(length);
          let filled = 0;
          while (filled < buffer.length) {
            const read = Number(yield* file.read(buffer.subarray(filled)));
            if (read === 0) break;
            filled += read;
          }
          return filled === buffer.length ? buffer : buffer.subarray(0, filled);
        }),
      );

    // Two writes to the same part must not read the same staged length and
    // then both append; the second would silently overwrite the first.
    const handoffPartWrites = yield* makeKeyedSerialExecutor<string>();

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const projects = yield* projectionSnapshotQuery.getShellSnapshotWithoutEnrichment();
          const threads = yield* threadManagement.getShellSnapshot();
          return {
            schemaVersion: threads.schemaVersion,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
            projects: projects.projects,
            threads: threads.threads,
            archivedThreads: threads.archivedThreads,
          } as const;
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "readHandoffPart",
        Effect.fn("environment.orchestration.readHandoffPart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const target = threadHandoff.partPath({
            handoffId: args.params.handoffId,
            kind: args.params.kind,
          });
          const exists = yield* fs
            .exists(target)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          if (!exists) {
            return yield* failEnvironmentNotFound("handoff_part_not_found");
          }
          const info = yield* fs
            .stat(target)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_handoff_part_failed", cause),
              ),
            );
          const totalBytes = Number(info.size);
          const window = ThreadHandoffService.handoffChunkWindow({
            totalBytes,
            offset: args.payload.offset,
            chunkBytes: ENVIRONMENT_HANDOFF_PART_CHUNK_BYTES,
          });
          const data = yield* readWindow(target, window.offset, window.end - window.offset).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_handoff_part_failed", cause),
            ),
          );
          return {
            offset: window.offset,
            totalBytes,
            data,
            complete: window.complete,
          };
        }),
      )
      .handle(
        "writeHandoffPart",
        Effect.fn("environment.orchestration.writeHandoffPart")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const target = threadHandoff.partPath({
            handoffId: args.params.handoffId,
            kind: args.params.kind,
          });
          return yield* handoffPartWrites.withLock(
            `${args.params.handoffId}:${args.params.kind}`,
            Effect.gen(function* () {
              const stagedBytes = yield* fs.exists(target).pipe(
                Effect.flatMap((exists) =>
                  exists
                    ? fs.stat(target).pipe(Effect.map((info) => Number(info.size)))
                    : Effect.succeed(0),
                ),
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_handoff_part_failed", cause),
                ),
              );
              const incoming = args.payload.data;
              // A chunk that does not continue exactly where the staged bytes
              // end would leave a hole, which would only surface later as a
              // digest mismatch or a corrupt bundle. A chunk that lands wholly
              // inside what is already staged is a retry of a write whose
              // response was lost, and is a no-op as long as the bytes agree.
              if (args.payload.offset > stagedBytes) {
                return yield* failEnvironmentInvalidRequest("handoff_part_offset_mismatch");
              }
              if (args.payload.offset + incoming.length <= stagedBytes) {
                const already = yield* readWindow(
                  target,
                  args.payload.offset,
                  incoming.length,
                ).pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_handoff_part_failed", cause),
                  ),
                );
                if (!bytesEqual(already, incoming)) {
                  return yield* failEnvironmentInvalidRequest("handoff_part_offset_mismatch");
                }
                return { receivedBytes: stagedBytes };
              }
              if (args.payload.offset !== stagedBytes) {
                return yield* failEnvironmentInvalidRequest("handoff_part_offset_mismatch");
              }
              if (stagedBytes + incoming.length > ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES) {
                return yield* failEnvironmentInvalidRequest("handoff_part_exceeds_max_bytes");
              }
              yield* fs
                .makeDirectory(path.dirname(target), { recursive: true })
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_handoff_part_failed", cause),
                  ),
                );
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(target, { flag: "a" });
                  yield* file.writeAll(incoming);
                }),
              ).pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_handoff_part_failed", cause),
                ),
              );
              return { receivedBytes: stagedBytes + incoming.length };
            }),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* threadManagement.getThreadSnapshot(args.params.threadId).pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      );
  }),
);
