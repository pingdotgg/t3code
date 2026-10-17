import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationConfigConflictError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AdministrationService from "./AdministrationService.ts";
import * as ConfigService from "./ConfigService.ts";

const projectId = ProjectId.make("project:civilization:admin");
const threadId = ThreadId.make("thread:civilization:admin");
const otherThreadId = ThreadId.make("thread:civilization:admin:other");
const isConflict = Schema.is(CivilizationConfigConflictError);

const unused = () => Effect.die("unused test dependency");

const makeThreadService = (title: Ref.Ref<string>, raceOnRestore: boolean, failRestore = false) =>
  ThreadManagement.ThreadManagementService.of({
    getThreadShell: unused,
    getShellSnapshot: unused,
    readShellSnapshot: unused,
    ensureLegacyTranscript: unused,
    dispatch: (command) => {
      if (command.type !== "thread.metadata.update" || command.title === undefined) {
        return Effect.die("Unexpected test command");
      }
      const nextTitle = command.title;
      return Effect.gen(function* () {
        if (failRestore) {
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Synthetic restore dispatch failure",
          });
        }
        if (raceOnRestore) yield* Ref.set(title, "Manual edit won the race");
        const current = yield* Ref.get(title);
        if (command.expectedTitle !== undefined && command.expectedTitle !== current) {
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} title changed before the metadata update could be applied.`,
          });
        }
        yield* Ref.set(title, nextTitle);
        return undefined as never;
      });
    },
    searchThread: unused,
    searchThreadStream: () => Stream.die("unused test dependency"),
    getThreadHistoryPage: unused,
    getTimelinePage: unused,
    getMessageCount: unused,
    getTurnItem: unused,
    getThreadRecords: unused,
    getThreadProjection: () =>
      Ref.get(title).pipe(Effect.map((current) => ({ thread: { title: current } }) as never)),
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: unused,
    getProjectThread: unused,
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: Stream.empty,
  });

const seedCitizen = Effect.fn("AdministrationService.test.seedCitizen")(function* (input?: {
  readonly id?: ThreadId;
  readonly name?: string;
  readonly titleManaged?: boolean;
  readonly observedOnly?: boolean;
  readonly preservedTitle?: string | null;
  readonly lastManagedTitle?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const id = input?.id ?? threadId;
  const name = input?.name ?? "Ada";
  const key = ConfigService.normalizeCivilizationName(name);
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
      ${id}, ${projectId}, NULL, NULL, ${id}, 0, 'resolved', ${input?.observedOnly === true ? 1 : 0},
      1, 1,
      'ada', 1, 'Ada', ${name}, ${key}, 'main',
      1, 0,
      'quiet', 'Quiet', '[]', '', 'profiles',
      1, 0,
      ${input?.titleManaged === false ? 0 : 1},
      ${input?.preservedTitle ?? "Manual title"},
      ${input?.lastManagedTitle ?? "[Ada] Managed topic"},
      'Managed topic',
      NULL, NULL, NULL,
      0, 0, 0, 1, datetime('now'), datetime('now')
    )
  `;
});

const enableFeature = Effect.fn("AdministrationService.test.enableFeature")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      names: {
        pools: [
          {
            id: "main",
            entries: [
              { id: "ada", displayName: "Ada", weight: 1 },
              { id: "grace", displayName: "Grace", weight: 1 },
            ],
          },
        ],
        selectedPoolId: "main",
      },
      personalities: {
        pools: [
          {
            id: "profiles",
            entries: [
              {
                id: "quiet",
                label: "Quiet",
                traits: [],
                styleText: "",
                rich: {
                  label: "Quiet Expert",
                  traits: ["quiet", "precise"],
                  axiom: "Precision before flourish.",
                  voice: "Quiet and precise.",
                  styleText: "Use a quiet, precise voice without changing task scope.",
                },
                weight: 1,
              },
              {
                id: "warm",
                label: "Warm",
                traits: ["conversational"],
                styleText: "Prefer a conversational tone.",
                rich: {
                  label: "Warm Craftsman",
                  traits: ["warm", "practical"],
                  axiom: "Make the useful thing understandable.",
                  voice: "Warm, practical, and concise.",
                  styleText: "Use a warm practical voice without changing task scope.",
                },
                weight: 1,
              },
            ],
          },
        ],
        selectedPoolId: "profiles",
      },
    },
  });
});

const makeLayer = (threads: ThreadManagement.ThreadManagementService["Service"]) => {
  const database = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    database,
    ConfigService.layer.pipe(Layer.provide(database)),
    AdministrationService.layer.pipe(
      Layer.provide(database),
      Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, threads)),
    ),
  );
};

it.effect(
  "previews and atomically applies explicit identity reassignment at citizen/config revisions",
  () =>
    Effect.gen(function* () {
      const title = yield* Ref.make("[Ada] Managed topic");
      const layer = makeLayer(makeThreadService(title, false));
      yield* Effect.gen(function* () {
        yield* enableFeature();
        yield* seedCitizen();
        const administration = yield* AdministrationService.CivilizationAdministrationService;
        const request = {
          projectId,
          threadId,
          expectedCitizenRevision: 1,
          expectedEnvironmentRevision: 1,
          expectedProjectRevision: 0,
          nameEntryId: "grace",
          profileEntryId: "warm",
        } as const;

        const preview = yield* administration.previewReassignment(request);
        assert.deepEqual(preview.current, {
          nameEntryId: "ada",
          name: "Ada",
          profileEntryId: "quiet",
          profileLabel: "Quiet",
        });
        assert.deepEqual(preview.proposed, {
          nameEntryId: "grace",
          name: "Grace",
          profileEntryId: "warm",
          profileLabel: "Warm",
        });

        const applied = yield* administration.applyReassignment(request);
        assert.equal(applied.name, "Grace");
        assert.equal(applied.profileId, "warm");
        assert.equal(applied.revision, 2);

        const stale = yield* administration.applyReassignment(request).pipe(Effect.flip);
        assert.isTrue(isConflict(stale));
        if (isConflict(stale)) assert.equal(stale.scope, "citizen");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "rejects exact custom-name collisions instead of silently stealing another citizen's name",
  () =>
    Effect.gen(function* () {
      const title = yield* Ref.make("[Ada] Managed topic");
      const layer = makeLayer(makeThreadService(title, false));
      yield* Effect.gen(function* () {
        yield* enableFeature();
        yield* seedCitizen();
        yield* seedCitizen({ id: otherThreadId, name: "Grace" });
        const administration = yield* AdministrationService.CivilizationAdministrationService;
        const error = yield* administration
          .previewReassignment({
            projectId,
            threadId,
            expectedCitizenRevision: 1,
            expectedEnvironmentRevision: 1,
            expectedProjectRevision: 0,
            displayName: "Grace",
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "CivilizationOperationInvalidError");
        if (error._tag === "CivilizationOperationInvalidError")
          assert.equal(error.reason, "name_conflict");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("restores only the still-managed title and relinquishes ownership", () =>
  Effect.gen(function* () {
    const title = yield* Ref.make("[Ada] Managed topic");
    const layer = makeLayer(makeThreadService(title, false));
    yield* Effect.gen(function* () {
      yield* seedCitizen();
      const administration = yield* AdministrationService.CivilizationAdministrationService;
      const result = yield* administration.restoreTitle({
        projectId,
        threadId,
        expectedCitizenRevision: 1,
      });
      assert.equal(result.threadTitle, "Manual title");
      assert.isFalse(result.citizen.titleManaged);
      assert.equal(yield* Ref.get(title), "Manual title");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("does not overwrite a manual rename that races title restore", () =>
  Effect.gen(function* () {
    const title = yield* Ref.make("[Ada] Managed topic");
    const layer = makeLayer(makeThreadService(title, true));
    yield* Effect.gen(function* () {
      yield* seedCitizen();
      const administration = yield* AdministrationService.CivilizationAdministrationService;
      const error = yield* administration
        .restoreTitle({ projectId, threadId, expectedCitizenRevision: 1 })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CivilizationAdministrationError");
      assert.equal(yield* Ref.get(title), "Manual edit won the race");
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{ readonly title_managed: number }>`
          SELECT title_managed FROM civilization_citizens WHERE thread_id = ${threadId}
        `)[0]!;
      assert.equal(row.title_managed, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("preserves managed ownership when title restore fails without a competing rename", () =>
  Effect.gen(function* () {
    const title = yield* Ref.make("[Ada] Managed topic");
    const layer = makeLayer(makeThreadService(title, false, true));
    yield* Effect.gen(function* () {
      yield* seedCitizen();
      const administration = yield* AdministrationService.CivilizationAdministrationService;
      const error = yield* administration
        .restoreTitle({ projectId, threadId, expectedCitizenRevision: 1 })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CivilizationAdministrationError");
      assert.equal(yield* Ref.get(title), "[Ada] Managed topic");
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{ readonly title_managed: number; readonly revision: number }>`
          SELECT title_managed, revision FROM civilization_citizens WHERE thread_id = ${threadId}
        `)[0]!;
      assert.deepEqual(row, { title_managed: 1, revision: 1 });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reclaims future title management without overwriting the current title", () =>
  Effect.gen(function* () {
    const title = yield* Ref.make("User-owned title");
    const layer = makeLayer(makeThreadService(title, false));
    yield* Effect.gen(function* () {
      yield* enableFeature();
      yield* seedCitizen({
        titleManaged: false,
        preservedTitle: "Old title",
        lastManagedTitle: "[Ada] Old",
      });
      const administration = yield* AdministrationService.CivilizationAdministrationService;
      const result = yield* administration.reclaimTitle({
        projectId,
        threadId,
        expectedCitizenRevision: 1,
      });
      assert.isTrue(result.citizen.titleManaged);
      assert.equal(result.threadTitle, "User-owned title");
      assert.equal(yield* Ref.get(title), "User-owned title");
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        readonly preserved_title: string;
        readonly last_managed_title: string | null;
      }>`
          SELECT preserved_title, last_managed_title
          FROM civilization_citizens WHERE thread_id = ${threadId}
        `)[0]!;
      assert.equal(row.preserved_title, "User-owned title");
      assert.isNull(row.last_managed_title);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses title reclaim for provider-owned observed agents", () =>
  Effect.gen(function* () {
    const title = yield* Ref.make("Provider-owned conversation");
    const layer = makeLayer(makeThreadService(title, false));
    yield* Effect.gen(function* () {
      yield* enableFeature();
      yield* seedCitizen({ titleManaged: false, observedOnly: true });
      const administration = yield* AdministrationService.CivilizationAdministrationService;
      const error = yield* administration
        .reclaimTitle({ projectId, threadId, expectedCitizenRevision: 1 })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CivilizationOperationInvalidError");
      if (error._tag === "CivilizationOperationInvalidError") {
        assert.equal(error.reason, "observed_agent_read_only");
      }
      assert.equal(yield* Ref.get(title), "Provider-owned conversation");
    }).pipe(Effect.provide(layer));
  }),
);
