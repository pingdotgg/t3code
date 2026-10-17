import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationAgentAccessError,
  CivilizationKnowledgeConflictError,
  CivilizationNoteNotFoundError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";

const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  database,
  ConfigService.layer.pipe(Layer.provide(database)),
  KnowledgeService.layer.pipe(Layer.provide(database)),
);

const isInvalid = Schema.is(KnowledgeService.CivilizationKnowledgeInvalidError);
const isConflict = Schema.is(CivilizationKnowledgeConflictError);
const isAccess = Schema.is(CivilizationAgentAccessError);
const isNotFound = Schema.is(CivilizationNoteNotFoundError);

const projectId = ProjectId.make("project:civilization:knowledge");
const callerThreadId = ThreadId.make("thread:civilization:knowledge:caller");

const insertProject = Effect.fn("KnowledgeService.test.insertProject")(function* (
  id: ProjectId = projectId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${id}, ${id}, '/tmp/civilization-knowledge', '[]',
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
    )
  `;
});

const seedCitizen = Effect.fn("KnowledgeService.test.seedCitizen")(function* (input: {
  readonly id: ThreadId;
  readonly name: string;
  readonly projectId?: ProjectId;
  readonly observedOnly?: boolean;
  readonly deleted?: boolean;
  readonly closed?: boolean;
  readonly epoch?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const owner = input.projectId ?? projectId;
  const key = ConfigService.normalizeCivilizationName(input.name);
  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id, generation, lineage_status, observed_only,
      birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted, revision, created_at, updated_at
    ) VALUES (
      ${input.id}, ${owner}, NULL, NULL, ${input.id}, 0, 'resolved', ${input.observedOnly === true ? 1 : 0},
      1, 1,
      ${`name:${input.id}`}, 1, ${input.name}, ${input.name}, ${key}, 'main',
      1, 0,
      'quiet', 'Quiet', '[]', '', 'profiles',
      1, 0,
      0, ${input.name}, NULL, ${input.name},
      NULL, NULL, NULL,
      ${input.epoch ?? 0}, ${input.closed === true ? 1 : 0}, ${input.deleted === true ? 1 : 0},
      1, datetime('now'), datetime('now')
    )
  `;
});

const enableFeature = Effect.fn("KnowledgeService.test.enableFeature")(function* (input?: {
  readonly censusPageSize?: number;
  readonly responseBodyBytes?: number;
  readonly noteBytes?: number;
  readonly activeNotes?: number;
  readonly showObservedAgents?: boolean;
}) {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: {
        enabled: true,
        ...(input?.showObservedAgents === undefined
          ? {}
          : { showObservedAgents: input.showObservedAgents }),
      },
      operations: {
        ...(input?.censusPageSize === undefined ? {} : { censusPageSize: input.censusPageSize }),
        ...(input?.responseBodyBytes === undefined
          ? {}
          : { responseBodyBytes: input.responseBodyBytes }),
      },
      knowledge: {
        ...(input?.noteBytes === undefined ? {} : { noteBytes: input.noteBytes }),
        ...(input?.activeNotes === undefined ? {} : { activeNotes: input.activeNotes }),
      },
    },
  });
});

const caller = (overrides: Partial<KnowledgeService.CivilizationAuthoritativeCaller> = {}) => ({
  threadId: callerThreadId,
  projectId,
  epoch: 0,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...overrides,
});

const setupCaller = Effect.fn("KnowledgeService.test.setupCaller")(function* (
  config?: Parameters<typeof enableFeature>[0],
) {
  yield* insertProject();
  yield* enableFeature(config);
  yield* seedCitizen({ id: callerThreadId, name: "Caller" });
});

it.effect("pages the census exactly by normalized name and thread id without duplicates", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* insertProject();
    yield* enableFeature({ censusPageSize: 2, showObservedAgents: false });
    yield* seedCitizen({ id: ThreadId.make("thread:z"), name: "Zulu" });
    yield* seedCitizen({ id: ThreadId.make("thread:a2"), name: "Beta" });
    yield* seedCitizen({ id: ThreadId.make("thread:a1"), name: "Alpha" });
    yield* seedCitizen({ id: ThreadId.make("thread:observed"), name: "Bravo", observedOnly: true });
    yield* seedCitizen({ id: ThreadId.make("thread:deleted"), name: "Charlie", deleted: true });

    const first = yield* service.listCensus({ projectId, limit: 100 });
    assert.lengthOf(first.citizens, 2);
    assert.isNotNull(first.nextCursor);
    assert.isTrue(first.partial);
    const second = yield* service.listCensus({ projectId, cursor: first.nextCursor! });
    assert.isNull(second.nextCursor);
    assert.isFalse(second.partial);

    const ids = [...first.citizens, ...second.citizens].map((citizen) => citizen.threadId);
    assert.deepEqual(ids, ["thread:a1", "thread:a2", "thread:z"]);
    assert.equal(new Set(ids).size, ids.length);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("rejects a census cursor after the collection revision changes", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* insertProject();
    yield* enableFeature({ censusPageSize: 1 });
    yield* seedCitizen({ id: ThreadId.make("thread:first"), name: "Alpha" });
    yield* seedCitizen({ id: ThreadId.make("thread:second"), name: "Bravo" });
    const first = yield* service.listCensus({ projectId });
    assert.isNotNull(first.nextCursor);

    yield* seedCitizen({ id: ThreadId.make("thread:later"), name: "Aardvark" });
    const stale = yield* Effect.flip(service.listCensus({ projectId, cursor: first.nextCursor! }));
    assert.isTrue(isConflict(stale));
    if (isConflict(stale)) {
      assert.equal(stale.entity, "census");
      assert.equal(stale.expectedRevision, first.revision);
      assert.isAbove(stale.currentRevision, first.revision);
    }
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "enforces UTF-8 note bytes, configured categories, source references, and the active cap",
  () =>
    Effect.gen(function* () {
      const service = yield* KnowledgeService.CivilizationKnowledgeService;
      yield* setupCaller({ noteBytes: 4, activeNotes: 1 });

      const accepted = yield* service.createNote({
        caller: caller(),
        clientRequestId: "utf8-ok",
        category: "fact",
        body: "🙂",
        sourceReferences: [{ kind: "thread", reference: "source-1" }],
      });
      assert.equal(accepted.bodyBytes, 4);

      const tooLarge = yield* Effect.flip(
        service.createNote({
          caller: caller(),
          clientRequestId: "utf8-too-large",
          category: "fact",
          body: "🙂a",
        }),
      );
      assert.isTrue(isInvalid(tooLarge));
      if (isInvalid(tooLarge)) assert.equal(tooLarge.reason, "note_too_large");

      const badCategory = yield* Effect.flip(
        service.createNote({
          caller: caller(),
          clientRequestId: "bad-category",
          category: "secret",
          body: "ok",
        }),
      );
      assert.isTrue(isInvalid(badCategory));
      if (isInvalid(badCategory)) assert.equal(badCategory.reason, "invalid_category");

      const duplicateSource = yield* Effect.flip(
        service.createNote({
          caller: caller(),
          clientRequestId: "duplicate-source",
          category: "fact",
          body: "ok",
          sourceReferences: [
            { kind: "thread", reference: "same" },
            { kind: "thread", reference: "same" },
          ],
        }),
      );
      assert.isTrue(isInvalid(duplicateSource));
      if (isInvalid(duplicateSource))
        assert.equal(duplicateSource.reason, "invalid_source_reference");

      const atCapacity = yield* Effect.flip(
        service.createNote({
          caller: caller(),
          clientRequestId: "at-capacity",
          category: "fact",
          body: "ok",
        }),
      );
      assert.isTrue(isInvalid(atCapacity));
      if (isInvalid(atCapacity)) assert.equal(atCapacity.reason, "active_note_limit");
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("uses expected revisions for note updates and keeps project-scoped reads", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* setupCaller();
    const note = yield* service.createNote({
      caller: caller(),
      clientRequestId: "conflict",
      category: "fact",
      body: "first",
    });
    const updated = yield* service.updateNote({
      caller: caller(),
      noteId: note.noteId,
      expectedRevision: 1,
      body: "second",
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.body, "second");

    const stale = yield* Effect.flip(
      service.updateNote({
        caller: caller(),
        noteId: note.noteId,
        expectedRevision: 1,
        body: "third",
      }),
    );
    assert.isTrue(isConflict(stale));
    if (isConflict(stale)) {
      assert.equal(stale.entity, "note");
      assert.equal(stale.currentRevision, 2);
    }

    const otherProject = ProjectId.make("project:civilization:knowledge:other");
    yield* insertProject(otherProject);
    const absent = yield* Effect.flip(
      service.readNoteMetadata({ projectId: otherProject, noteId: note.noteId }),
    );
    assert.isTrue(isNotFound(absent));
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("resolve frees active capacity and reopening respects the cap", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* setupCaller({ activeNotes: 1 });
    const first = yield* service.createNote({
      caller: caller(),
      clientRequestId: "resolve-first",
      category: "fact",
      body: "first",
    });
    const resolved = yield* service.resolveNote({
      caller: caller(),
      noteId: first.noteId,
      expectedRevision: first.revision,
      resolved: true,
    });
    const afterResolve = yield* service.getProjectRevisions(projectId);
    assert.isNotNull(resolved.resolvedAt);
    assert.equal(resolved.revision, 2);
    assert.equal(afterResolve.notes_revision, 2);

    const second = yield* service.createNote({
      caller: caller(),
      clientRequestId: "resolve-second",
      category: "fact",
      body: "second",
    });
    assert.equal(second.revision, 1);

    const cannotReopen = yield* Effect.flip(
      service.resolveNote({
        caller: caller(),
        noteId: first.noteId,
        expectedRevision: resolved.revision,
        resolved: false,
      }),
    );
    assert.isTrue(isInvalid(cannotReopen));
    if (isInvalid(cannotReopen)) assert.equal(cannotReopen.reason, "active_note_limit");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("retries deterministic creates without duplicating the note or collection revision", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* setupCaller();
    const input = {
      caller: caller(),
      clientRequestId: "stable-retry",
      category: "fact",
      body: "same body",
    } as const;
    const first = yield* service.createNote(input);
    const afterFirst = yield* service.getProjectRevisions(projectId);
    const retry = yield* service.createNote(input);
    const afterRetry = yield* service.getProjectRevisions(projectId);
    assert.equal(retry.noteId, first.noteId);
    assert.equal(retry.revision, first.revision);
    assert.equal(afterRetry.notes_revision, afterFirst.notes_revision);

    const changedRetry = yield* Effect.flip(service.createNote({ ...input, body: "changed" }));
    assert.isTrue(isConflict(changedRetry));
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("rechecks caller epoch/lifecycle and persists the accepted transfer ceiling", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    const sql = yield* SqlClient.SqlClient;
    yield* setupCaller();
    const resolvedCaller = yield* service.authoritativeCaller({
      threadId: callerThreadId,
      projectId,
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
    assert.equal(resolvedCaller.epoch, 0);
    const note = yield* service.createNote({
      caller: resolvedCaller,
      clientRequestId: "mode-ceiling",
      category: "fact",
      body: "bounded",
    });
    assert.equal(note.acceptedRuntimeMode, "auto-accept-edits");
    assert.equal(note.acceptedInteractionMode, "plan");
    const metadata = yield* service.readNoteMetadata({ projectId, noteId: note.noteId });
    assert.equal(metadata.noteId, note.noteId);
    const allowedBody = yield* service.readNoteBody({
      projectId,
      noteId: note.noteId,
      reader: { runtimeMode: "approval-required", interactionMode: "plan" },
    });
    assert.equal(allowedBody.body, "bounded");
    const deniedBody = yield* Effect.flip(
      service.readNoteBody({
        projectId,
        noteId: note.noteId,
        reader: { runtimeMode: "full-access", interactionMode: "default" },
      }),
    );
    assert.isTrue(isAccess(deniedBody));

    yield* sql`
      UPDATE civilization_citizens SET epoch = 1 WHERE thread_id = ${callerThreadId}
    `;
    const staleCaller = yield* Effect.flip(
      service.createNote({
        caller: caller(),
        clientRequestId: "stale-epoch",
        category: "fact",
        body: "stale",
      }),
    );
    assert.isTrue(isAccess(staleCaller));
    if (isAccess(staleCaller)) assert.equal(staleCaller.reason, "stale_epoch");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("refuses one citizen from updating or resolving another citizen's note", () =>
  Effect.gen(function* () {
    const service = yield* KnowledgeService.CivilizationKnowledgeService;
    yield* setupCaller();
    const otherThreadId = ThreadId.make("thread:civilization:knowledge:other-author");
    yield* seedCitizen({ id: otherThreadId, name: "Other" });
    const note = yield* service.createNote({
      caller: caller(),
      clientRequestId: "owned-note",
      category: "fact",
      body: "owned by caller",
    });
    const otherCaller = caller({ threadId: otherThreadId });

    const updateDenied = yield* Effect.flip(
      service.updateNote({
        caller: otherCaller,
        noteId: note.noteId,
        expectedRevision: note.revision,
        body: "takeover",
      }),
    );
    assert.isTrue(isAccess(updateDenied));
    if (isAccess(updateDenied)) assert.equal(updateDenied.reason, "forbidden");

    const resolveDenied = yield* Effect.flip(
      service.resolveNote({
        caller: otherCaller,
        noteId: note.noteId,
        expectedRevision: note.revision,
        resolved: true,
      }),
    );
    assert.isTrue(isAccess(resolveDenied));
    if (isAccess(resolveDenied)) assert.equal(resolveDenied.reason, "forbidden");

    const unchanged = yield* service.readNoteBody({ projectId, noteId: note.noteId });
    assert.equal(unchanged.body, "owned by caller");
    assert.equal(unchanged.revision, 1);
    assert.isNull(unchanged.resolvedAt);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
