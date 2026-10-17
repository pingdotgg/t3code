// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Opaque cursor and persisted source-reference JSON are deliberate storage/wire encodings at this boundary.
import * as NodeCrypto from "node:crypto";

import {
  CIVILIZATION_MAX_NOTE_BYTES,
  CivilizationAgentAccessError,
  CivilizationCensusCursor,
  CivilizationKnowledgeConflictError,
  type CivilizationCitizenSummary,
  type CivilizationLineageStatus,
  type CivilizationNoteBody,
  CivilizationNoteId,
  type CivilizationNoteSourceReference,
  type CivilizationNoteSummary,
  CivilizationNoteNotFoundError,
  CivilizationNotesCursor,
  type CivilizationRelationshipToParent,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { getEffectiveCivilizationConfig } from "./ConfigService.ts";

const CURSOR_VERSION = 1 as const;
const MAX_SOURCE_REFERENCES = 16;
const MAX_SOURCE_KIND_BYTES = 128;
const MAX_SOURCE_REFERENCE_BYTES = 2 * 1024;

export class CivilizationKnowledgeInvalidError extends Schema.TaggedError<CivilizationKnowledgeInvalidError>()(
  "CivilizationKnowledgeInvalidError",
  {
    reason: Schema.Literals([
      "invalid_cursor",
      "response_too_large",
      "invalid_note",
      "invalid_category",
      "note_too_large",
      "invalid_source_reference",
      "active_note_limit",
      "no_changes",
    ]),
    message: Schema.String,
  },
) {}

type CollectionStateRow = {
  readonly census_revision: number;
  readonly notes_revision: number;
};

type CensusRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly name_display: string;
  readonly name_key: string;
  readonly profile_entry_id: string;
  readonly profile_label: string;
  readonly generation: number;
  readonly lineage_status: CivilizationLineageStatus;
  readonly parent_thread_id: ThreadId | null;
  readonly relationship_to_parent: CivilizationRelationshipToParent;
  readonly observed_only: number;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly title_managed: number;
  readonly revision: number;
};

type NoteRow = {
  readonly note_id: string;
  readonly project_id: ProjectId;
  readonly category: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly author_thread_id: ThreadId;
  readonly author_epoch: number;
  readonly accepted_runtime_mode: RuntimeMode;
  readonly accepted_interaction_mode: ProviderInteractionMode;
  readonly source_refs_json: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
};

type MutationCitizenRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly observed_only: number;
};

type CensusCursorPayload = {
  readonly v: typeof CURSOR_VERSION;
  readonly kind: "census";
  readonly projectId: string;
  readonly revision: number;
  readonly environmentRevision: number;
  readonly projectRevision: number;
  readonly includeObserved: boolean;
  readonly afterNameKey: string;
  readonly afterThreadId: string;
};

type NotesCursorPayload = {
  readonly v: typeof CURSOR_VERSION;
  readonly kind: "notes";
  readonly projectId: string;
  readonly revision: number;
  readonly includeResolved: boolean;
  readonly selection: "recent" | "stable_id";
  readonly afterUpdatedAt: string;
  readonly afterNoteId: string;
};

type CursorPayload = CensusCursorPayload | NotesCursorPayload;

export interface CivilizationCensusPageInput {
  readonly projectId: ProjectId;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface CivilizationCensusServicePage {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly citizens: ReadonlyArray<CivilizationCitizenSummary>;
  readonly nextCursor: typeof CivilizationCensusCursor.Type | null;
  readonly partial: boolean;
}

export interface CivilizationNotesPageInput {
  readonly projectId: ProjectId;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly includeResolved?: boolean | undefined;
  readonly selection?: "recent" | "stable_id" | undefined;
}

export interface CivilizationNotesServicePage {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly notes: ReadonlyArray<CivilizationNoteSummary>;
  readonly nextCursor: typeof CivilizationNotesCursor.Type | null;
  readonly partial: boolean;
}

export interface CivilizationAuthoritativeCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly epoch: number;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface CivilizationNoteCreateInput {
  readonly caller: CivilizationAuthoritativeCaller;
  readonly clientRequestId: string;
  readonly category: string;
  readonly body: string;
  readonly sourceReferences?: ReadonlyArray<CivilizationNoteSourceReference> | undefined;
}

export interface CivilizationNoteUpdateInput {
  readonly caller: CivilizationAuthoritativeCaller;
  readonly noteId: typeof CivilizationNoteId.Type;
  readonly expectedRevision: number;
  readonly category?: string | undefined;
  readonly body?: string | undefined;
  readonly sourceReferences?: ReadonlyArray<CivilizationNoteSourceReference> | undefined;
}

export interface CivilizationNoteResolveInput {
  readonly caller: CivilizationAuthoritativeCaller;
  readonly noteId: typeof CivilizationNoteId.Type;
  readonly expectedRevision: number;
  readonly resolved: boolean;
}

export interface CivilizationNoteReaderCeiling {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const invalid = (reason: CivilizationKnowledgeInvalidError["reason"], message: string) =>
  new CivilizationKnowledgeInvalidError({ reason, message });

const isKnowledgeInvalid = Schema.is(CivilizationKnowledgeInvalidError);
const knowledgeSync = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      isKnowledgeInvalid(cause)
        ? cause
        : invalid("invalid_note", "Civilization knowledge validation failed."),
  });

const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");

const unsafeText = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export const encodeCivilizationCensusCursor = (input: Omit<CensusCursorPayload, "v" | "kind">) =>
  CivilizationCensusCursor.make(encodeCursor({ v: CURSOR_VERSION, kind: "census", ...input }));

export const encodeCivilizationNotesCursor = (input: Omit<NotesCursorPayload, "v" | "kind">) =>
  CivilizationNotesCursor.make(encodeCursor({ v: CURSOR_VERSION, kind: "notes", ...input }));

function decodeCursor(cursor: string): CursorPayload {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
      throw new Error("non-canonical cursor");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== CURSOR_VERSION || (parsed.kind !== "census" && parsed.kind !== "notes")) {
      throw new Error("unsupported cursor");
    }
    return parsed as unknown as CursorPayload;
  } catch {
    throw invalid("invalid_cursor", "The Civilization cursor is invalid or unsupported.");
  }
}

function decodeCensusCursor(
  cursor: string | undefined,
  projectId: ProjectId,
): CensusCursorPayload | undefined {
  if (cursor === undefined) return undefined;
  const parsed = decodeCursor(cursor);
  if (
    parsed.kind !== "census" ||
    parsed.projectId !== projectId ||
    !Number.isSafeInteger(parsed.revision) ||
    !Number.isSafeInteger(parsed.environmentRevision) ||
    !Number.isSafeInteger(parsed.projectRevision) ||
    typeof parsed.includeObserved !== "boolean" ||
    typeof parsed.afterNameKey !== "string" ||
    typeof parsed.afterThreadId !== "string"
  ) {
    throw invalid("invalid_cursor", "The Civilization census cursor does not match this project.");
  }
  return parsed;
}

function decodeNotesCursor(
  cursor: string | undefined,
  projectId: ProjectId,
): NotesCursorPayload | undefined {
  if (cursor === undefined) return undefined;
  const parsed = decodeCursor(cursor);
  if (
    parsed.kind !== "notes" ||
    parsed.projectId !== projectId ||
    !Number.isSafeInteger(parsed.revision) ||
    typeof parsed.includeResolved !== "boolean" ||
    (parsed.selection !== "recent" && parsed.selection !== "stable_id") ||
    typeof parsed.afterUpdatedAt !== "string" ||
    typeof parsed.afterNoteId !== "string"
  ) {
    throw invalid("invalid_cursor", "The Civilization notes cursor does not match this project.");
  }
  return parsed;
}

function censusSummary(row: CensusRow): CivilizationCitizenSummary {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    name: row.name_display,
    profileId: row.profile_entry_id,
    profileLabel: row.profile_label,
    generation: row.generation,
    lineageStatus: row.lineage_status,
    parentThreadId: row.parent_thread_id,
    relationshipToParent: row.relationship_to_parent,
    observedOnly: row.observed_only === 1,
    epoch: row.epoch,
    closed: row.closed === 1,
    deleted: row.deleted === 1,
    titleManaged: row.title_managed === 1,
    revision: row.revision,
  };
}

function noteSummary(row: NoteRow): CivilizationNoteSummary {
  return {
    noteId: CivilizationNoteId.make(row.note_id),
    projectId: row.project_id,
    category: row.category,
    bodyBytes: row.body_bytes,
    authorThreadId: row.author_thread_id,
    authorEpoch: row.author_epoch,
    acceptedRuntimeMode: row.accepted_runtime_mode,
    acceptedInteractionMode: row.accepted_interaction_mode,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function decodeSourceReferences(row: NoteRow): ReadonlyArray<CivilizationNoteSourceReference> {
  try {
    const parsed = JSON.parse(row.source_refs_json) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.map((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { kind?: unknown }).kind !== "string" ||
        typeof (value as { reference?: unknown }).reference !== "string"
      ) {
        throw new Error("invalid source reference");
      }
      return {
        kind: (value as { kind: string }).kind,
        reference: (value as { reference: string }).reference,
      };
    });
  } catch {
    throw invalid(
      "invalid_source_reference",
      "Stored Civilization note source references are invalid.",
    );
  }
}

function noteBody(row: NoteRow): CivilizationNoteBody {
  return { ...noteSummary(row), body: row.body, sourceReferences: decodeSourceReferences(row) };
}

export const civilizationNoteVisibleWithinCeiling = (
  note: Pick<CivilizationNoteSummary, "acceptedRuntimeMode" | "acceptedInteractionMode">,
  reader: CivilizationNoteReaderCeiling,
) =>
  exceededDispatchModeLimit(
    {
      runtimeMode: note.acceptedRuntimeMode,
      interactionMode: note.acceptedInteractionMode,
    },
    reader,
  ) === undefined;

function validateSourceReferences(
  sourceReferences: ReadonlyArray<CivilizationNoteSourceReference>,
): ReadonlyArray<CivilizationNoteSourceReference> {
  if (sourceReferences.length > MAX_SOURCE_REFERENCES) {
    throw invalid(
      "invalid_source_reference",
      `A Civilization note may contain at most ${MAX_SOURCE_REFERENCES} source references.`,
    );
  }
  const seen = new Set<string>();
  for (const source of sourceReferences) {
    if (
      source.kind.trim().length === 0 ||
      source.reference.trim().length === 0 ||
      utf8Length(source.kind) > MAX_SOURCE_KIND_BYTES ||
      utf8Length(source.reference) > MAX_SOURCE_REFERENCE_BYTES ||
      unsafeText(source.kind) ||
      unsafeText(source.reference)
    ) {
      throw invalid(
        "invalid_source_reference",
        "A Civilization note source reference is empty, too large, or contains unsafe formatting.",
      );
    }
    const key = `${source.kind}\u0000${source.reference}`;
    if (seen.has(key)) {
      throw invalid(
        "invalid_source_reference",
        "Duplicate Civilization note source references are not allowed.",
      );
    }
    seen.add(key);
  }
  return sourceReferences;
}

function validateNoteContent(input: {
  readonly category: string;
  readonly body: string;
  readonly sourceReferences: ReadonlyArray<CivilizationNoteSourceReference>;
  readonly noteCategories: ReadonlyArray<string>;
  readonly noteBytes: number;
}) {
  if (!input.noteCategories.includes(input.category)) {
    throw invalid(
      "invalid_category",
      `Civilization note category '${input.category}' is not enabled.`,
    );
  }
  if (input.body.trim().length === 0 || unsafeText(input.body)) {
    throw invalid(
      "invalid_note",
      "A Civilization note body must be non-empty and safely encoded text.",
    );
  }
  const bodyBytes = utf8Length(input.body);
  if (bodyBytes > Math.min(input.noteBytes, CIVILIZATION_MAX_NOTE_BYTES)) {
    throw invalid(
      "note_too_large",
      `Civilization note body exceeds the configured ${input.noteBytes} UTF-8 byte limit.`,
    );
  }
  validateSourceReferences(input.sourceReferences);
  return bodyBytes;
}

const stableNoteId = (caller: CivilizationAuthoritativeCaller, clientRequestId: string) => {
  if (
    clientRequestId.trim().length === 0 ||
    utf8Length(clientRequestId) > 1024 ||
    unsafeText(clientRequestId)
  ) {
    throw invalid(
      "invalid_note",
      "clientRequestId is empty, too large, or contains unsafe formatting.",
    );
  }
  const digest = NodeCrypto.createHash("sha256")
    .update(
      `${caller.projectId}\u0000${caller.threadId}\u0000${caller.epoch}\u0000${clientRequestId}`,
      "utf8",
    )
    .digest("base64url")
    .slice(0, 32);
  return CivilizationNoteId.make(`note:${digest}`);
};

const pageSize = (requested: number | undefined, configured: number) => {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw invalid("invalid_cursor", "Civilization page limit must be a positive integer.");
  }
  return Math.min(requested ?? configured, configured);
};

const responseBytes = (value: unknown) => utf8Length(JSON.stringify(value));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getProjectRevisions = Effect.fn("CivilizationKnowledge.getProjectRevisions")(function* (
    projectId: ProjectId,
  ) {
    const row = (yield* sql<CollectionStateRow>`
        SELECT census_revision, notes_revision
        FROM civilization_project_state
        WHERE project_id = ${projectId}
        LIMIT 1
      `)[0];
    return row ?? { census_revision: 0, notes_revision: 0 };
  });

  const listCensus = Effect.fn("CivilizationKnowledge.listCensus")(function* (
    input: CivilizationCensusPageInput,
  ) {
    const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const state = yield* getProjectRevisions(input.projectId);
    const cursor = yield* knowledgeSync(() => decodeCensusCursor(input.cursor, input.projectId));
    const includeObserved = effective.config.participation.showObservedAgents;
    if (cursor !== undefined) {
      if (cursor.revision !== state.census_revision) {
        return yield* new CivilizationKnowledgeConflictError({
          code: "civilization_knowledge_conflict",
          entity: "census",
          expectedRevision: cursor.revision,
          currentRevision: state.census_revision,
        });
      }
      if (
        cursor.environmentRevision !== effective.environmentRevision ||
        cursor.projectRevision !== effective.projectRevision ||
        cursor.includeObserved !== includeObserved
      ) {
        return yield* invalid(
          "invalid_cursor",
          "Civilization census visibility changed after this cursor was issued.",
        );
      }
    }
    const limit = yield* knowledgeSync(() =>
      pageSize(input.limit, effective.config.operations.censusPageSize),
    );
    const rows =
      cursor === undefined
        ? yield* sql<CensusRow>`
          SELECT thread_id, project_id, name_display, name_key, profile_entry_id, profile_label,
                 generation, lineage_status, parent_thread_id, relationship_to_parent,
                 observed_only, epoch, closed, deleted, title_managed, revision
          FROM civilization_citizens
          WHERE project_id = ${input.projectId}
            AND deleted = 0
            AND (${includeObserved ? 1 : 0} = 1 OR observed_only = 0)
          ORDER BY name_key ASC, thread_id ASC
          LIMIT ${limit + 1}
        `
        : yield* sql<CensusRow>`
          SELECT thread_id, project_id, name_display, name_key, profile_entry_id, profile_label,
                 generation, lineage_status, parent_thread_id, relationship_to_parent,
                 observed_only, epoch, closed, deleted, title_managed, revision
          FROM civilization_citizens
          WHERE project_id = ${input.projectId}
            AND deleted = 0
            AND (${includeObserved ? 1 : 0} = 1 OR observed_only = 0)
            AND (name_key > ${cursor.afterNameKey}
              OR (name_key = ${cursor.afterNameKey} AND thread_id > ${cursor.afterThreadId}))
          ORDER BY name_key ASC, thread_id ASC
          LIMIT ${limit + 1}
        `;

    const citizens: Array<CivilizationCitizenSummary> = [];
    let byteLimited = false;
    for (const row of rows.slice(0, limit)) {
      const candidate = censusSummary(row);
      const nextCursor = encodeCivilizationCensusCursor({
        projectId: input.projectId,
        revision: state.census_revision,
        environmentRevision: effective.environmentRevision,
        projectRevision: effective.projectRevision,
        includeObserved,
        afterNameKey: row.name_key,
        afterThreadId: row.thread_id,
      });
      const nextPage = {
        projectId: input.projectId,
        revision: state.census_revision,
        citizens: [...citizens, candidate],
        nextCursor,
        partial: true,
      };
      if (responseBytes(nextPage) > effective.config.operations.responseBodyBytes) {
        byteLimited = true;
        break;
      }
      citizens.push(candidate);
    }
    if (rows.length > 0 && citizens.length === 0) {
      return yield* invalid(
        "response_too_large",
        "The configured Civilization response-body limit cannot fit one census entry.",
      );
    }
    const hasMore = byteLimited || rows.length > citizens.length;
    const last = citizens.length === 0 ? undefined : rows[citizens.length - 1];
    const nextCursor =
      !hasMore || last === undefined
        ? null
        : encodeCivilizationCensusCursor({
            projectId: input.projectId,
            revision: state.census_revision,
            environmentRevision: effective.environmentRevision,
            projectRevision: effective.projectRevision,
            includeObserved,
            afterNameKey: last.name_key,
            afterThreadId: last.thread_id,
          });
    return {
      projectId: input.projectId,
      revision: state.census_revision,
      citizens,
      nextCursor,
      partial: hasMore,
    } satisfies CivilizationCensusServicePage;
  });

  const listNotes = Effect.fn("CivilizationKnowledge.listNotes")(function* (
    input: CivilizationNotesPageInput,
  ) {
    const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const state = yield* getProjectRevisions(input.projectId);
    const cursor = yield* knowledgeSync(() => decodeNotesCursor(input.cursor, input.projectId));
    const includeResolved = input.includeResolved ?? false;
    const selection = input.selection ?? "recent";
    if (cursor !== undefined) {
      if (cursor.revision !== state.notes_revision) {
        return yield* new CivilizationKnowledgeConflictError({
          code: "civilization_knowledge_conflict",
          entity: "note",
          expectedRevision: cursor.revision,
          currentRevision: state.notes_revision,
        });
      }
      if (cursor.includeResolved !== includeResolved || cursor.selection !== selection) {
        return yield* invalid(
          "invalid_cursor",
          "Civilization note filters changed after this cursor was issued.",
        );
      }
    }
    const limit = yield* knowledgeSync(() =>
      pageSize(input.limit, effective.config.operations.censusPageSize),
    );
    const rows =
      selection === "stable_id"
        ? cursor === undefined
          ? yield* sql<NoteRow>`
            SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                   accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                   created_at, updated_at, resolved_at
            FROM civilization_notes
            WHERE project_id = ${input.projectId}
              AND (${includeResolved ? 1 : 0} = 1 OR resolved_at IS NULL)
            ORDER BY note_id ASC
            LIMIT ${limit + 1}
          `
          : yield* sql<NoteRow>`
            SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                   accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                   created_at, updated_at, resolved_at
            FROM civilization_notes
            WHERE project_id = ${input.projectId}
              AND (${includeResolved ? 1 : 0} = 1 OR resolved_at IS NULL)
              AND note_id > ${cursor.afterNoteId}
            ORDER BY note_id ASC
            LIMIT ${limit + 1}
          `
        : cursor === undefined
          ? yield* sql<NoteRow>`
            SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                   accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                   created_at, updated_at, resolved_at
            FROM civilization_notes
            WHERE project_id = ${input.projectId}
              AND (${includeResolved ? 1 : 0} = 1 OR resolved_at IS NULL)
            ORDER BY updated_at DESC, note_id DESC
            LIMIT ${limit + 1}
          `
          : yield* sql<NoteRow>`
            SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                   accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                   created_at, updated_at, resolved_at
            FROM civilization_notes
            WHERE project_id = ${input.projectId}
              AND (${includeResolved ? 1 : 0} = 1 OR resolved_at IS NULL)
              AND (updated_at < ${cursor.afterUpdatedAt}
                OR (updated_at = ${cursor.afterUpdatedAt} AND note_id < ${cursor.afterNoteId}))
            ORDER BY updated_at DESC, note_id DESC
            LIMIT ${limit + 1}
          `;
    const notes: Array<CivilizationNoteSummary> = [];
    let byteLimited = false;
    for (const row of rows.slice(0, limit)) {
      const candidate = noteSummary(row);
      const nextCursor = encodeCivilizationNotesCursor({
        projectId: input.projectId,
        revision: state.notes_revision,
        includeResolved,
        selection,
        afterUpdatedAt: row.updated_at,
        afterNoteId: row.note_id,
      });
      const nextPage = {
        projectId: input.projectId,
        revision: state.notes_revision,
        notes: [...notes, candidate],
        nextCursor,
        partial: true,
      };
      if (responseBytes(nextPage) > effective.config.operations.responseBodyBytes) {
        byteLimited = true;
        break;
      }
      notes.push(candidate);
    }
    if (rows.length > 0 && notes.length === 0) {
      return yield* invalid(
        "response_too_large",
        "The configured Civilization response-body limit cannot fit one note summary.",
      );
    }
    const hasMore = byteLimited || rows.length > notes.length;
    const last = notes.length === 0 ? undefined : rows[notes.length - 1];
    const nextCursor =
      !hasMore || last === undefined
        ? null
        : encodeCivilizationNotesCursor({
            projectId: input.projectId,
            revision: state.notes_revision,
            includeResolved,
            selection,
            afterUpdatedAt: last.updated_at,
            afterNoteId: last.note_id,
          });
    return {
      projectId: input.projectId,
      revision: state.notes_revision,
      notes,
      nextCursor,
      partial: hasMore,
    } satisfies CivilizationNotesServicePage;
  });

  const requireNote = Effect.fn("CivilizationKnowledge.requireNote")(function* (
    projectId: ProjectId,
    noteId: typeof CivilizationNoteId.Type,
  ) {
    const row = (yield* sql<NoteRow>`
        SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
               accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
               created_at, updated_at, resolved_at
        FROM civilization_notes
        WHERE project_id = ${projectId} AND note_id = ${noteId}
        LIMIT 1
      `)[0];
    if (row === undefined) {
      return yield* new CivilizationNoteNotFoundError({
        code: "civilization_note_not_found",
        noteId,
      });
    }
    return row;
  });

  const readNoteMetadata = Effect.fn("CivilizationKnowledge.readNoteMetadata")(function* (input: {
    readonly projectId: ProjectId;
    readonly noteId: typeof CivilizationNoteId.Type;
  }) {
    return noteSummary(yield* requireNote(input.projectId, input.noteId));
  });

  const readNoteBody = Effect.fn("CivilizationKnowledge.readNoteBody")(function* (input: {
    readonly projectId: ProjectId;
    readonly noteId: typeof CivilizationNoteId.Type;
    readonly reader?: CivilizationNoteReaderCeiling | undefined;
  }) {
    const row = yield* requireNote(input.projectId, input.noteId);
    const body = yield* knowledgeSync(() => noteBody(row));
    if (input.reader !== undefined && !civilizationNoteVisibleWithinCeiling(body, input.reader)) {
      return yield* new CivilizationAgentAccessError({
        code: "civilization_agent_access_denied",
        reason: "forbidden",
        message: "This note body was accepted above the reader's current mode ceiling.",
      });
    }
    return body;
  });

  const authorizeMutationThread = Effect.fn("CivilizationKnowledge.authorizeMutationThread")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }) {
      const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (!effective.config.participation.enabled || effective.config.participation.emergencyOff) {
        return yield* new CivilizationAgentAccessError({
          code: "civilization_agent_access_denied",
          reason: "disabled",
          message: "Civilization knowledge mutations are disabled for this project.",
        });
      }
      const citizen = (yield* sql<MutationCitizenRow>`
        SELECT thread_id, project_id, epoch, closed, deleted, observed_only
        FROM civilization_citizens
        WHERE thread_id = ${input.threadId}
        LIMIT 1
      `)[0];
      if (citizen === undefined || citizen.project_id !== input.projectId) {
        return yield* new CivilizationAgentAccessError({
          code: "civilization_agent_access_denied",
          reason: "unadopted",
          message: "The authenticated thread is not an adopted citizen of this project.",
        });
      }
      if (citizen.deleted === 1) {
        return yield* new CivilizationAgentAccessError({
          code: "civilization_agent_access_denied",
          reason: "deleted_citizen",
          message: "Deleted citizens cannot mutate Civilization knowledge.",
        });
      }
      if (citizen.observed_only === 1) {
        return yield* new CivilizationAgentAccessError({
          code: "civilization_agent_access_denied",
          reason: "observed_agent_read_only",
          message: "Observed provider-owned agents cannot mutate Civilization knowledge.",
        });
      }
      if (citizen.closed === 1) {
        return yield* new CivilizationAgentAccessError({
          code: "civilization_agent_access_denied",
          reason: "closed_citizen",
          message: "Settled or archived citizens cannot mutate Civilization knowledge.",
        });
      }
      return {
        caller: {
          threadId: citizen.thread_id,
          projectId: citizen.project_id,
          epoch: citizen.epoch,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
        } satisfies CivilizationAuthoritativeCaller,
        effective,
      } as const;
    },
  );

  const authoritativeCaller = Effect.fn("CivilizationKnowledge.authoritativeCaller")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }) {
      return (yield* authorizeMutationThread(input)).caller;
    },
  );

  const requireMutationCaller = Effect.fn("CivilizationKnowledge.requireMutationCaller")(function* (
    caller: CivilizationAuthoritativeCaller,
  ) {
    const authorized = yield* authorizeMutationThread(caller);
    if (authorized.caller.epoch !== caller.epoch) {
      return yield* new CivilizationAgentAccessError({
        code: "civilization_agent_access_denied",
        reason: "stale_epoch",
        message: "The authenticated Civilization epoch is stale.",
      });
    }
    return authorized;
  });

  const activeNoteCount = Effect.fn("CivilizationKnowledge.activeNoteCount")(function* (
    projectId: ProjectId,
  ) {
    return (
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM civilization_notes
        WHERE project_id = ${projectId} AND resolved_at IS NULL
      `)[0]?.count ?? 0
    );
  });

  const createNote = Effect.fn("CivilizationKnowledge.createNote")(function* (
    input: CivilizationNoteCreateInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { effective } = yield* requireMutationCaller(input.caller);
        const noteId = yield* knowledgeSync(() =>
          stableNoteId(input.caller, input.clientRequestId),
        );
        const { sources, bodyBytes } = yield* knowledgeSync(() => {
          const sources = validateSourceReferences(input.sourceReferences ?? []);
          const bodyBytes = validateNoteContent({
            category: input.category,
            body: input.body,
            sourceReferences: sources,
            noteCategories: effective.config.knowledge.noteCategories,
            noteBytes: effective.config.knowledge.noteBytes,
          });
          return { sources, bodyBytes };
        });
        const existing = (yield* sql<NoteRow>`
            SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                   accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                   created_at, updated_at, resolved_at
            FROM civilization_notes
            WHERE note_id = ${noteId}
            LIMIT 1
          `)[0];
        const sourceJson = JSON.stringify(sources);
        if (existing !== undefined) {
          if (
            existing.project_id === input.caller.projectId &&
            existing.author_thread_id === input.caller.threadId &&
            existing.author_epoch === input.caller.epoch &&
            existing.category === input.category &&
            existing.body === input.body &&
            existing.source_refs_json === sourceJson &&
            existing.accepted_runtime_mode === input.caller.runtimeMode &&
            existing.accepted_interaction_mode === input.caller.interactionMode
          ) {
            return yield* knowledgeSync(() => noteBody(existing));
          }
          return yield* new CivilizationKnowledgeConflictError({
            code: "civilization_knowledge_conflict",
            entity: "note",
            expectedRevision: 0,
            currentRevision: existing.revision,
          });
        }
        if (
          (yield* activeNoteCount(input.caller.projectId)) >= effective.config.knowledge.activeNotes
        ) {
          return yield* invalid(
            "active_note_limit",
            `Project has reached its configured limit of ${effective.config.knowledge.activeNotes} active notes.`,
          );
        }
        yield* sql`
          INSERT INTO civilization_notes (
            note_id, project_id, category, body, body_bytes,
            author_thread_id, author_epoch, accepted_runtime_mode, accepted_interaction_mode,
            source_refs_json, revision, created_at, updated_at, resolved_at
          ) VALUES (
            ${noteId}, ${input.caller.projectId}, ${input.category}, ${input.body}, ${bodyBytes},
            ${input.caller.threadId}, ${input.caller.epoch}, ${input.caller.runtimeMode}, ${input.caller.interactionMode},
            ${sourceJson}, 1, datetime('now'), datetime('now'), NULL
          )
        `;
        const created = yield* requireNote(input.caller.projectId, noteId);
        return yield* knowledgeSync(() => noteBody(created));
      }),
    );
  });

  const updateNote = Effect.fn("CivilizationKnowledge.updateNote")(function* (
    input: CivilizationNoteUpdateInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { effective } = yield* requireMutationCaller(input.caller);
        const row = yield* requireNote(input.caller.projectId, input.noteId);
        if (row.revision !== input.expectedRevision) {
          return yield* new CivilizationKnowledgeConflictError({
            code: "civilization_knowledge_conflict",
            entity: "note",
            expectedRevision: input.expectedRevision,
            currentRevision: row.revision,
          });
        }
        if (
          row.author_thread_id !== input.caller.threadId ||
          row.author_epoch !== input.caller.epoch
        ) {
          return yield* new CivilizationAgentAccessError({
            code: "civilization_agent_access_denied",
            reason: "forbidden",
            message: "A citizen may update only notes it authored in its current epoch.",
          });
        }
        if (
          input.category === undefined &&
          input.body === undefined &&
          input.sourceReferences === undefined
        ) {
          return yield* invalid(
            "no_changes",
            "A Civilization note update must change at least one field.",
          );
        }
        const category = input.category ?? row.category;
        const body = input.body ?? row.body;
        const { sourceJson, bodyBytes } = yield* knowledgeSync(() => {
          const sources =
            input.sourceReferences === undefined
              ? decodeSourceReferences(row)
              : validateSourceReferences(input.sourceReferences);
          const sourceJson = JSON.stringify(sources);
          const bodyBytes = validateNoteContent({
            category,
            body,
            sourceReferences: sources,
            noteCategories: effective.config.knowledge.noteCategories,
            noteBytes: effective.config.knowledge.noteBytes,
          });
          return { sourceJson, bodyBytes };
        });
        if (category === row.category && body === row.body && sourceJson === row.source_refs_json) {
          return yield* invalid(
            "no_changes",
            "The requested Civilization note update changes nothing.",
          );
        }
        yield* sql`
          UPDATE civilization_notes
          SET category = ${category}, body = ${body}, body_bytes = ${bodyBytes},
              source_refs_json = ${sourceJson}, revision = revision + 1, updated_at = datetime('now')
          WHERE note_id = ${row.note_id} AND project_id = ${input.caller.projectId} AND revision = ${row.revision}
        `;
        const updated = yield* requireNote(input.caller.projectId, input.noteId);
        return yield* knowledgeSync(() => noteBody(updated));
      }),
    );
  });

  const resolveNote = Effect.fn("CivilizationKnowledge.resolveNote")(function* (
    input: CivilizationNoteResolveInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { effective } = yield* requireMutationCaller(input.caller);
        const row = yield* requireNote(input.caller.projectId, input.noteId);
        if (row.revision !== input.expectedRevision) {
          return yield* new CivilizationKnowledgeConflictError({
            code: "civilization_knowledge_conflict",
            entity: "note",
            expectedRevision: input.expectedRevision,
            currentRevision: row.revision,
          });
        }
        if (
          row.author_thread_id !== input.caller.threadId ||
          row.author_epoch !== input.caller.epoch
        ) {
          return yield* new CivilizationAgentAccessError({
            code: "civilization_agent_access_denied",
            reason: "forbidden",
            message: "A citizen may resolve only notes it authored in its current epoch.",
          });
        }
        const currentlyResolved = row.resolved_at !== null;
        if (currentlyResolved === input.resolved) {
          return yield* invalid(
            "no_changes",
            "The Civilization note is already in the requested state.",
          );
        }
        if (
          !input.resolved &&
          (yield* activeNoteCount(input.caller.projectId)) >= effective.config.knowledge.activeNotes
        ) {
          return yield* invalid(
            "active_note_limit",
            `Project has reached its configured limit of ${effective.config.knowledge.activeNotes} active notes.`,
          );
        }
        if (input.resolved) {
          yield* sql`
            UPDATE civilization_notes
            SET resolved_at = datetime('now'), revision = revision + 1, updated_at = datetime('now')
            WHERE note_id = ${row.note_id} AND project_id = ${input.caller.projectId}
              AND revision = ${row.revision}
          `;
        } else {
          yield* sql`
            UPDATE civilization_notes
            SET resolved_at = NULL, revision = revision + 1, updated_at = datetime('now')
            WHERE note_id = ${row.note_id} AND project_id = ${input.caller.projectId}
              AND revision = ${row.revision}
          `;
        }
        const resolved = yield* requireNote(input.caller.projectId, input.noteId);
        return yield* knowledgeSync(() => noteBody(resolved));
      }),
    );
  });

  const selectNotesForContext = Effect.fn("CivilizationKnowledge.selectNotesForContext")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
      readonly selection: "recent" | "stable_id";
      readonly reader: CivilizationNoteReaderCeiling;
    }) {
      if (input.limit <= 0) return [];
      const scanLimit = Math.max(input.limit * 4, input.limit);
      const rows =
        input.selection === "recent"
          ? yield* sql<NoteRow>`
          SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                 accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                 created_at, updated_at, resolved_at
          FROM civilization_notes
          WHERE project_id = ${input.projectId} AND resolved_at IS NULL
          ORDER BY updated_at DESC, note_id DESC
          LIMIT ${scanLimit}
        `
          : yield* sql<NoteRow>`
          SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                 accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                 created_at, updated_at, resolved_at
          FROM civilization_notes
          WHERE project_id = ${input.projectId} AND resolved_at IS NULL
          ORDER BY note_id ASC
          LIMIT ${scanLimit}
        `;
      return yield* knowledgeSync(() =>
        rows
          .map(noteBody)
          .filter((note) => civilizationNoteVisibleWithinCeiling(note, input.reader))
          .slice(0, input.limit),
      );
    },
  );

  return {
    listCensus,
    listNotes,
    readNoteMetadata,
    readNoteBody,
    createNote,
    updateNote,
    resolveNote,
    selectNotesForContext,
    getProjectRevisions,
    authoritativeCaller,
  } as const;
});

export type CivilizationKnowledgeServiceShape = Effect.Success<typeof make>;

const unavailableKnowledge = () =>
  Effect.die("Civilization knowledge is not installed in this runtime layer.");

const unavailableKnowledgeService = {
  listCensus: () => unavailableKnowledge(),
  listNotes: () => unavailableKnowledge(),
  readNoteMetadata: () => unavailableKnowledge(),
  readNoteBody: () => unavailableKnowledge(),
  createNote: () => unavailableKnowledge(),
  updateNote: () => unavailableKnowledge(),
  resolveNote: () => unavailableKnowledge(),
  selectNotesForContext: () => unavailableKnowledge(),
  getProjectRevisions: () => unavailableKnowledge(),
  authoritativeCaller: () => unavailableKnowledge(),
} satisfies CivilizationKnowledgeServiceShape;

export class CivilizationKnowledgeService extends Context.Reference<CivilizationKnowledgeServiceShape>(
  "t3/civilization/KnowledgeService/CivilizationKnowledgeService",
  { defaultValue: () => unavailableKnowledgeService },
) {}

export const layer = Layer.effect(CivilizationKnowledgeService, make);
