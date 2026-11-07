import {
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { normalizeAttachmentRelativePath } from "../attachmentPaths.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Drains a worker bundle into an ARCHIVED read-only thread (spec 7.4): the snapshot's projection
 * replays through the EventSink (lossless; no lossy AgentSessionImporter fallback). Idempotency:
 * migration-083 rows mark {environmentId, drainId, snapshotSequence} — same sequence skips,
 * changed supersedes via projection upserts; crashes before the marker only warn (content stays).
 */ /** One attachment file recorded in a bundle envelope's manifest. */
export interface BundleAttachmentManifestEntry {
  readonly name: string;
  readonly hash: string;
  readonly size: number;
}

/** Transcription of one imports-table row; `snapshotSequence` decides currency. */
export interface FleetDrainImportRow {
  readonly threadId: string;
  readonly environmentId: string;
  readonly drainId: string;
  readonly snapshotSequence: number | null;
  readonly importedAt: string;
  readonly oversizeAttachmentsSkipped: boolean;
}

export class FleetDrainImportError extends Schema.TaggedError<FleetDrainImportError>()(
  "FleetDrainImportError",
  {
    operation: Schema.Literals(["read-bundle", "decode", "record", "restore-attachments"]),
    threadId: Schema.optional(ThreadId),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Where import state lives; sqlite-backed in production, faked in tests. */
export interface FleetDrainImportStore {
  readonly find: (
    threadId: string,
  ) => Effect.Effect<FleetDrainImportRow | null, FleetDrainImportError>;
  readonly threadExists: (threadId: string) => Effect.Effect<boolean, FleetDrainImportError>;
  readonly record: (row: FleetDrainImportRow) => Effect.Effect<void, FleetDrainImportError>;
}

const EVENT_PREFIX = "fleet-drain";
const TRANSCRIPT_EVENT_BATCH_SIZE = 100;
const TITLE_SUFFIX_OF = (environmentId: string) => ` (drained from ${environmentId})`;

const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot),
);

const decodeEnvelopeJson = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.optional(Schema.String),
      snapshot: Schema.optional(Schema.Unknown),
      pages: Schema.optional(
        Schema.Array(
          Schema.Struct({
            items: Schema.optional(
              Schema.Array(Schema.Struct({ item: Schema.optional(Schema.Unknown) })),
            ),
          }),
        ),
      ),
      attachments: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            hash: Schema.String,
            size: Schema.Number,
          }),
        ),
      ),
      attachmentsSkipped: Schema.optional(Schema.Boolean),
    }),
  ),
);

const archivedThreadPayload = (input: {
  readonly thread: OrchestrationV2AppThread;
  readonly environmentId: string;
  readonly archivedAt: DateTime.Utc;
}): OrchestrationV2AppThread => ({
  ...input.thread,
  title: input.thread.title.endsWith(TITLE_SUFFIX_OF(input.environmentId))
    ? input.thread.title
    : `${input.thread.title}${TITLE_SUFFIX_OF(input.environmentId)}`,
  tags: [...new Set([...(input.thread.tags ?? []), `${EVENT_PREFIX}:${input.environmentId}`])],
  archivedAt: input.archivedAt,
  updatedAt: input.archivedAt,
});

const importEventId = (parts: {
  readonly threadId: string;
  readonly snapshotSequence: number | null;
  readonly kind: string;
  readonly ref: string;
}): EventId =>
  EventId.make(
    `${EVENT_PREFIX}:${parts.threadId}:s${parts.snapshotSequence ?? "none"}:${parts.kind}:${parts.ref}`,
  );

const transcriptEvents = (input: {
  readonly threadId: ThreadId;
  readonly occurredAt: DateTime.Utc;
  readonly snapshotSequence: number | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): Array<OrchestrationV2DomainEvent> => [
  ...input.turnItems.map((item): OrchestrationV2DomainEvent => ({
    id: importEventId({
      threadId: input.threadId,
      snapshotSequence: input.snapshotSequence,
      kind: "turn-item",
      ref: item.id,
    }),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: input.occurredAt,
    payload: item,
  })),
  ...input.messages.map((message): OrchestrationV2DomainEvent => ({
    id: importEventId({
      threadId: input.threadId,
      snapshotSequence: input.snapshotSequence,
      kind: "message",
      ref: message.id,
    }),
    type: "message.updated",
    threadId: input.threadId,
    occurredAt: input.occurredAt,
    payload: message,
  })),
];

const inBatches = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const restoreAttachments = Effect.fn("FleetBundleImport.restoreAttachments")(function* (input: {
  readonly manifest: ReadonlyArray<BundleAttachmentManifestEntry>;
  readonly bundleDir: string;
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const segment = toSafeThreadAttachmentSegment(input.threadId);
  if (segment === null) return;
  for (const entry of input.manifest) {
    // Names come from the worker's attachment segment listing; only a flat,
    // traversal-free name may land under this thread's own directory.
    const name = normalizeAttachmentRelativePath(entry.name);
    if (name === null || name.includes("/") || name !== entry.name) continue;
    const source = input.path.join(
      input.bundleDir,
      `thread-${encodeURIComponent(input.threadId)}-att-${entry.hash.slice(0, 16)}.bin`,
    );
    const bytes = yield* input.fs.readFile(source).pipe(
      Effect.mapError(
        (cause) =>
          new FleetDrainImportError({
            operation: "restore-attachments",
            threadId: ThreadId.make(input.threadId),
            message: `Attachment ${entry.name} could not be read back from the bundle.`,
            cause,
          }),
      ),
    );
    const target = input.path.join(input.attachmentsDir, segment, name);
    yield* input.fs.makeDirectory(input.path.dirname(target), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new FleetDrainImportError({
            operation: "restore-attachments",
            threadId: ThreadId.make(input.threadId),
            message: `Attachment directory for ${input.threadId} could not be created.`,
            cause,
          }),
      ),
    );
    yield* input.fs.writeFile(target, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new FleetDrainImportError({
            operation: "restore-attachments",
            threadId: ThreadId.make(input.threadId),
            message: `Attachment ${entry.name} could not be restored.`,
            cause,
          }),
      ),
    );
  }
});

export interface FleetBundleImporterShape {
  /** Imports every bundle in a drain directory; per-thread problems warn, never throw. */
  readonly importBundle: (input: {
    readonly environmentId: string;
    readonly drainId: string;
  }) => Effect.Effect<
    {
      readonly imported: number;
      readonly skipped: number;
      readonly warnings: ReadonlyArray<string>;
    },
    FleetDrainImportError
  >;
}

interface BundleEnvelope {
  readonly threadId?: string | undefined;
  readonly snapshot?: unknown;
  readonly pages?:
    | ReadonlyArray<{ items?: ReadonlyArray<{ item?: unknown }> | undefined }>
    | undefined;
  readonly attachments?: ReadonlyArray<BundleAttachmentManifestEntry> | undefined;
  readonly attachmentsSkipped?: boolean | undefined;
}

export const makeFleetBundleImporter = (input: {
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly now: Effect.Effect<number>;
  readonly eventSink: Pick<EventSink.EventSinkV2["Service"], "write">;
  readonly store: FleetDrainImportStore;
}): FleetBundleImporterShape => {
  const { fs, path, stateDir } = input;
  return {
    importBundle: Effect.fn("FleetBundleImport.importBundle")(function* (request) {
      const bundleDir = path.join(
        stateDir,
        "fleet-drain",
        encodeURIComponent(request.environmentId),
        encodeURIComponent(request.drainId),
      );
      const entries = yield* fs.readDirectory(bundleDir).pipe(
        Effect.mapError(
          (cause) =>
            new FleetDrainImportError({
              operation: "read-bundle",
              message: `The drain bundle directory for ${request.drainId} could not be read.`,
              cause,
            }),
        ),
      );
      let imported = 0;
      let skipped = 0;
      const warnings: string[] = [];
      for (const file of entries.filter((name) => /^thread-.*\.json$/.test(name))) {
        const outcome = yield* Effect.gen(function* () {
          const raw = yield* fs.readFileString(path.join(bundleDir, file)).pipe(
            Effect.mapError(
              (cause) =>
                new FleetDrainImportError({
                  operation: "read-bundle",
                  message: `Bundle ${file} could not be read.`,
                  cause,
                }),
            ),
          );
          const decodedEnvelope = yield* decodeEnvelopeJson(raw).pipe(
            Effect.mapError(
              (cause) =>
                new FleetDrainImportError({
                  operation: "decode",
                  message: `Bundle ${file} is not a drained thread copy.`,
                  cause,
                }),
            ),
          );
          const envelope: BundleEnvelope = decodedEnvelope;
          const threadId = envelope.threadId;
          if (threadId === undefined || envelope.snapshot === undefined) {
            return yield* new FleetDrainImportError({
              operation: "decode",
              message: `Bundle ${file} is not a drained thread copy.`,
            });
          }
          const snapshot = yield* decodeSnapshot(envelope.snapshot).pipe(
            Effect.mapError(
              (cause) =>
                new FleetDrainImportError({
                  operation: "decode",
                  threadId: ThreadId.make(threadId),
                  message: `Bundle ${file} does not hold a readable thread snapshot.`,
                  cause,
                }),
            ),
          );
          const snapshotSequence = snapshot.snapshotSequence;
          const existing = yield* input.store.find(threadId);
          if (
            existing !== null &&
            existing.snapshotSequence !== null &&
            existing.snapshotSequence === snapshotSequence
          ) {
            return "skipped" as const;
          }
          const exists = yield* input.store.threadExists(threadId);
          if (exists && existing === null) {
            // A local thread that was not drain-imported owns this id; archiving
            // or overwriting it would destroy local work, so the bundle stays.
            warnings.push(
              `Thread ${threadId} already exists here and was not drain-imported; its bundle was not imported.`,
            );
            return "skipped" as const;
          }
          const now = DateTime.makeUnsafe(yield* input.now);
          const payload = archivedThreadPayload({
            thread: snapshot.projection.thread,
            environmentId: request.environmentId,
            archivedAt: now,
          });
          const turnItems = [
            ...snapshot.projection.turnItems,
            ...(envelope.pages ?? []).flatMap((page) =>
              (page.items ?? []).flatMap((entry) =>
                entry.item === undefined ? [] : [entry.item as OrchestrationV2TurnItem],
              ),
            ),
          ];
          const thread = ThreadId.make(threadId);
          const head: OrchestrationV2DomainEvent = {
            id: importEventId({
              threadId,
              snapshotSequence,
              kind: "thread",
              ref: String(snapshotSequence ?? "none"),
            }),
            type: existing === null ? "thread.created" : "thread.metadata-updated",
            threadId: thread,
            providerInstanceId: payload.providerInstanceId,
            occurredAt: now,
            payload,
          };
          const providerThreadEvents: Array<OrchestrationV2DomainEvent> =
            snapshot.projection.providerThreads.map(
              (providerThread): OrchestrationV2DomainEvent => ({
                id: importEventId({
                  threadId,
                  snapshotSequence,
                  kind: "provider-thread",
                  ref: providerThread.id,
                }),
                type: "provider-thread.updated",
                threadId: thread,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: now,
                payload: providerThread,
              }),
            );
          // Restore attachment files before recording, so a crash between the
          // two leaves files but no marker and the retry replays idempotently.
          yield* restoreAttachments({
            manifest: envelope.attachments ?? [],
            bundleDir,
            attachmentsDir: input.attachmentsDir,
            threadId,
            fs,
            path,
          });
          yield* input.eventSink.write({
            events: [head, ...providerThreadEvents],
          });
          const transcript = transcriptEvents({
            threadId: thread,
            occurredAt: now,
            snapshotSequence,
            turnItems,
            messages: snapshot.projection.messages,
          });
          for (const batch of inBatches(transcript, TRANSCRIPT_EVENT_BATCH_SIZE)) {
            yield* input.eventSink.write({ events: [...batch] });
          }
          yield* input.store.record({
            threadId,
            environmentId: request.environmentId,
            drainId: request.drainId,
            snapshotSequence,
            importedAt: DateTime.formatIso(now),
            oversizeAttachmentsSkipped: envelope.attachmentsSkipped === true,
          });
          return "imported" as const;
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              warnings.push(`Bundle ${file} could not be imported: ${String(cause).slice(0, 200)}`);
              return "failed" as const;
            }),
          ),
        );
        if (outcome === "imported") imported += 1;
        else if (outcome === "skipped") skipped += 1;
      }
      return { imported, skipped, warnings };
    }),
  };
};

/**
 * The sqlite-backed import-state store over migration 083's table; tests run
 * it on the in-memory sqlite layer like the other persistence stores.
 */
export const sqliteFleetDrainImportStore = (sql: SqlClient.SqlClient): FleetDrainImportStore => {
  const failed = (message: string, cause: unknown) =>
    new FleetDrainImportError({ operation: "record", message, cause });
  return {
    find: (threadId) =>
      sql<{
        readonly thread_id: string;
        readonly environment_id: string;
        readonly drain_id: string;
        readonly snapshot_sequence: number | null;
        readonly imported_at: string;
        readonly oversize_attachments_skipped: number;
      }>`
        SELECT thread_id, environment_id, drain_id, snapshot_sequence, imported_at, oversize_attachments_skipped
        FROM orchestration_v2_fleet_drain_imports
        WHERE thread_id = ${threadId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined
            ? null
            : {
                threadId: row.thread_id,
                environmentId: row.environment_id,
                drainId: row.drain_id,
                snapshotSequence: row.snapshot_sequence,
                importedAt: row.imported_at,
                oversizeAttachmentsSkipped: row.oversize_attachments_skipped === 1,
              };
        }),
        Effect.mapError((cause) =>
          failed("The fleet drain import state could not be read.", cause),
        ),
      ),
    threadExists: (threadId) =>
      sql<{ readonly present: number }>`
        SELECT 1 AS present
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) => failed("The thread projection could not be consulted.", cause)),
      ),
    record: (row) =>
      sql`
        INSERT INTO orchestration_v2_fleet_drain_imports
          (thread_id, environment_id, drain_id, snapshot_sequence, imported_at, lossy, oversize_attachments_skipped)
        VALUES (${row.threadId}, ${row.environmentId}, ${row.drainId}, ${row.snapshotSequence}, ${row.importedAt}, 0, ${row.oversizeAttachmentsSkipped ? 1 : 0})
        ON CONFLICT(thread_id) DO UPDATE SET
          environment_id = excluded.environment_id,
          drain_id = excluded.drain_id,
          snapshot_sequence = excluded.snapshot_sequence,
          imported_at = excluded.imported_at,
          oversize_attachments_skipped = excluded.oversize_attachments_skipped
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          failed(`The fleet drain import state for ${row.threadId} could not be recorded.`, cause),
        ),
      ),
  };
};
