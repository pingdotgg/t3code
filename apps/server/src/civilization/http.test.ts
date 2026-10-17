import {
  AuthSessionId,
  CIVILIZATION_CONFIG_VERSION,
  CivilizationCensusCursor,
  CivilizationInboxCursor,
  CivilizationMessageId,
  CivilizationNoteId,
  CivilizationNotesCursor,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AdministrationService from "./AdministrationService.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as CivilizationHttp from "./http.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";
import * as OperationsService from "./OperationsService.ts";

class CivilizationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.civilization,
) {}

const database = SqlitePersistence.layerMemory;
const fakeAdministration = AdministrationService.CivilizationAdministrationService.of({
  previewReassignment: () => Effect.die("unused administration preview"),
  applyReassignment: () => Effect.die("unused administration apply"),
  reclaimTitle: () => Effect.die("unused administration reclaim"),
  restoreTitle: () => Effect.die("unused administration restore"),
});
const fakeKnowledge = KnowledgeService.CivilizationKnowledgeService.of({
  listCensus: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, citizens: [], nextCursor: null, partial: false }),
  listNotes: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, notes: [], nextCursor: null, partial: false }),
  readNoteMetadata: () => Effect.die("unused note metadata read"),
  readNoteBody: () => Effect.die("unused note body read"),
  createNote: () => Effect.die("unused note create"),
  updateNote: () => Effect.die("unused note update"),
  resolveNote: () => Effect.die("unused note resolve"),
  selectNotesForContext: () => Effect.die("unused context note selection"),
  getProjectRevisions: () => Effect.die("unused project revisions read"),
  authoritativeCaller: () => Effect.die("unused authoritative caller lookup"),
});
const fakeMail = MailService.CivilizationMailService.of({
  authoritativeCaller: () => Effect.die("unused mail caller lookup"),
  send: () => Effect.die("unused mail send"),
  listInbox: () => Effect.die("unused agent inbox list"),
  receive: () => Effect.die("unused mail receive"),
  acknowledge: () => Effect.die("unused mail acknowledge"),
  selectInboxForContext: () => Effect.die("unused context inbox selection"),
  selectInboxForContextAfterAuthority: () =>
    Effect.die("unused post-authority context inbox selection"),
  offerInboxForContext: () => Effect.die("unused context inbox offer"),
  listAdminMail: () => Effect.die("unused admin mail list"),
  readAdminMessage: () => Effect.die("unused admin mail read"),
  cleanupProject: () => Effect.die("unused mail cleanup"),
});
const fakeOperations = OperationsService.CivilizationOperationsService.of({
  exportProjectData: () => Effect.die("unused project data export"),
  previewPurge: () => Effect.die("unused purge preview"),
  applyPurge: () => Effect.die("unused purge apply"),
  cleanupDeletedProject: () => Effect.die("unused deleted-project cleanup"),
  getAppliedRetentionPolicy: () => Effect.die("unused retention policy read"),
  previewRetentionReduction: () => Effect.die("unused retention preview"),
  applyRetentionReduction: () => Effect.die("unused retention apply"),
});

const makeRoutes = (
  adoptionCalls: Ref.Ref<number>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  knowledge: KnowledgeService.CivilizationKnowledgeServiceShape = fakeKnowledge,
  mail: MailService.CivilizationMailServiceShape = fakeMail,
  operations: OperationsService.CivilizationOperationsServiceShape = fakeOperations,
) => {
  const fakeCitizens = CitizenService.CivilizationCitizenService.of({
    adoptExisting: () =>
      Ref.update(adoptionCalls, (count) => count + 1).pipe(
        Effect.as({ candidates: 0, adopted: 0, skipped: 0 }),
      ),
    reconcileExisting: () =>
      Effect.succeed({ citizenCount: 0, caughtUpCitizenCount: 0, appliedEventCount: 0 }),
    getCitizen: () => Effect.succeed(null),
  });
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("civilization-http-test"),
        subject: "civilization-http-test",
        method: "browser-session-cookie",
        scopes: new Set(scopes),
      }),
    ),
  );
  return HttpApiBuilder.layer(CivilizationTestApi).pipe(
    Layer.provide(CivilizationHttp.layer),
    Layer.provide(auth),
    Layer.provide(ConfigService.layer.pipe(Layer.provide(database))),
    Layer.provide(Layer.succeed(CitizenService.CivilizationCitizenService, fakeCitizens)),
    Layer.provide(
      Layer.succeed(AdministrationService.CivilizationAdministrationService, fakeAdministration),
    ),
    Layer.provide(Layer.succeed(KnowledgeService.CivilizationKnowledgeService, knowledge)),
    Layer.provide(Layer.succeed(MailService.CivilizationMailService, mail)),
    Layer.provide(Layer.succeed(OperationsService.CivilizationOperationsService, operations)),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
    Layer.provide(database),
  );
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// `toWebHandler` retains the route layer's SqlClient requirement in its request-context
// type even though the database is already provided above; runtime needs no request service.
const requestContext = Context.empty() as Context.Context<SqlClient.SqlClient>;
const postJson = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeJson(body),
  });

it("reports unexpected provider unavailability as degraded without penalizing metadata-only support", () => {
  const base = {
    status: "active" as const,
    environmentRevision: 1,
    projectRevision: 2,
    citizenCount: 3,
    openCitizenCount: 2,
  };
  const metadataOnly = {
    providerInstanceId: ProviderInstanceId.make("cursor-main"),
    support: "metadata_only" as const,
    contextInjection: false,
    keyedContextReplacement: false,
    actionablePromptRefresh: false,
    providerContinuationRefresh: false,
    messaging: false,
  };
  const unavailable = {
    ...metadataOnly,
    providerInstanceId: ProviderInstanceId.make("codex-unavailable"),
    support: "unsupported" as const,
  };
  expect(CivilizationHttp.civilizationStatusWithCapabilities(base, [metadataOnly])).toMatchObject({
    status: "active",
    providerCapabilities: [{ support: "metadata_only" }],
  });
  expect(
    CivilizationHttp.civilizationStatusWithCapabilities(base, [metadataOnly, unavailable]),
  ).toMatchObject({
    status: "degraded",
    detail: "One or more registered provider adapters are unavailable.",
    providerCapabilities: [{ support: "metadata_only" }, { support: "unsupported" }],
  });
  expect(
    CivilizationHttp.civilizationStatusWithCapabilities({ ...base, status: "disabled" }, [
      unavailable,
    ]),
  ).toMatchObject({ status: "disabled" });
});

it.effect(
  "allows orchestration reads while keeping Civilization mutations behind settings:write",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(makeRoutes(adoptionCalls, ["orchestration:read"]), {
            disableLogger: true,
          }),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const readResponse = await server.handler(
              new Request("http://127.0.0.1/api/civilization/status"),
              requestContext,
            );
            expect(readResponse.status).toBe(200);

            const capabilityResponse = await server.handler(
              new Request("http://127.0.0.1/api/civilization/capabilities"),
              requestContext,
            );
            expect(capabilityResponse.status).toBe(200);
            expect(await capabilityResponse.json()).toEqual({ providers: [] });

            const inspectionListResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/context-inspections?projectId=project%3Aread-only&limit=25",
              ),
              requestContext,
            );
            expect(inspectionListResponse.status).toBe(200);
            expect(await inspectionListResponse.json()).toEqual({
              projectId: "project:read-only",
              inspections: [],
              nextCursor: null,
              partial: false,
            });

            const noteBodyResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/notes/note%3Aread-only?projectId=project%3Aread-only",
              ),
              requestContext,
            );
            expect(noteBodyResponse.status).toBe(403);
            expect(await noteBodyResponse.json()).toMatchObject({
              code: "insufficient_scope",
              requiredPermission: "settings:write",
            });

            for (const path of [
              "/api/civilization/context-inspections/context%3Aread-only?projectId=project%3Aread-only",
              "/api/civilization/inbox?projectId=project%3Aread-only",
              "/api/civilization/inbox/mail%3Aread-only?projectId=project%3Aread-only",
              "/api/civilization/export?projectId=project%3Aread-only",
              "/api/civilization/purge/preview?projectId=project%3Aread-only",
              "/api/civilization/retention?projectId=project%3Aread-only",
              "/api/civilization/retention/preview?projectId=project%3Aread-only",
            ]) {
              const mailResponse = await server.handler(
                new Request(`http://127.0.0.1${path}`),
                requestContext,
              );
              expect(mailResponse.status).toBe(403);
              expect(await mailResponse.json()).toMatchObject({
                code: "insufficient_scope",
                requiredPermission: "settings:write",
              });
            }

            const purgeApply = await server.handler(
              postJson("/api/civilization/purge/apply", {
                projectId: "project:read-only",
                expectedPreviewToken: "sha256:test",
                batchSize: 10,
              }),
              requestContext,
            );
            expect(purgeApply.status).toBe(403);

            const retentionApply = await server.handler(
              postJson("/api/civilization/retention/apply", {
                projectId: "project:read-only",
                expectedPreviewToken: "sha256:test",
              }),
              requestContext,
            );
            expect(retentionApply.status).toBe(403);

            const mutationResponse = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: true },
                },
              }),
              requestContext,
            );
            expect(mutationResponse.status).toBe(403);
            expect(await mutationResponse.json()).toMatchObject({
              code: "insufficient_scope",
              requiredScope: "orchestration:operate",
              requiredPermission: "settings:write",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
    }),
);

it.effect("rejects malformed Civilization context-inspector numeric filters", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(makeRoutes(adoptionCalls, ["orchestration:read"]), {
          disableLogger: true,
        }),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          for (const query of ["limit=abc", "limit=0", "providerTurnOrdinal=-1"]) {
            const response = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/context-inspections?projectId=project%3Afilters&${query}`,
              ),
              requestContext,
            );
            expect(response.status).toBe(400);
          }
        }),
      (server) => Effect.promise(() => server.dispose()),
    );
  }),
);

it.effect(
  "routes retention inspection and apply through the administrative operations service",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const projectId = ProjectId.make("project:civilization:http-retention");
      const getInput = yield* Ref.make<ProjectId | null>(null);
      const previewInput = yield* Ref.make<ProjectId | null>(null);
      const applyInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly expectedPreviewToken: string;
      } | null>(null);
      const operations = OperationsService.CivilizationOperationsService.of({
        ...fakeOperations,
        getAppliedRetentionPolicy: (input) =>
          Ref.set(getInput, input).pipe(
            Effect.as({
              noteRetentionDays: 30,
              diagnosticRetentionDays: 7,
              tombstoneRetentionDays: 30,
            }),
          ),
        previewRetentionReduction: (input) =>
          Ref.set(previewInput, input).pipe(
            Effect.as({
              projectId,
              previewToken: "sha256:retention-preview",
              environmentRevision: 2,
              projectRevision: 3,
              current: {
                noteRetentionDays: 30,
                diagnosticRetentionDays: 7,
                tombstoneRetentionDays: 30,
              },
              configured: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              proposed: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 99,
                diagnosticReferences: 4,
                diagnosticInspections: 2,
                tombstones: 1,
              },
              samples: {
                noteIds: ["note:one"],
                contextReferenceIds: ["context:one"],
                contextInspectionIds: ["inspection:one"],
                tombstoneThreadIds: ["thread:one"],
                partial: true,
              },
              warnings: [
                "Applying this preview changes only approved retention horizons. Scheduled bounded cleanup performs physical deletion afterward.",
                "Active notes and citizen identity are not retention-cleanup candidates.",
              ],
            }),
          ),
        applyRetentionReduction: (input) =>
          Ref.set(applyInput, input).pipe(
            Effect.as({
              projectId,
              applied: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 99,
                diagnosticReferences: 4,
                diagnosticInspections: 2,
                tombstones: 1,
              },
            }),
          ),
      });

      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read", "orchestration:operate", "settings:write"],
              fakeKnowledge,
              fakeMail,
              operations,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const get = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/retention?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(get.status).toBe(200);
            expect(await get.json()).toEqual({
              noteRetentionDays: 30,
              diagnosticRetentionDays: 7,
              tombstoneRetentionDays: 30,
            });

            const preview = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/retention/preview?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(preview.status).toBe(200);
            expect(await preview.json()).toMatchObject({
              projectId,
              previewToken: "sha256:retention-preview",
              newlyEligible: { resolvedNotes: 2, diagnosticReferences: 4 },
            });

            const apply = await server.handler(
              postJson("/api/civilization/retention/apply", {
                projectId,
                expectedPreviewToken: "sha256:retention-preview",
              }),
              requestContext,
            );
            expect(apply.status).toBe(200);
            expect(await apply.json()).toMatchObject({
              projectId,
              applied: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(
          Effect.all({
            get: Ref.get(getInput),
            preview: Ref.get(previewInput),
            apply: Ref.get(applyInput),
          }),
        ),
        Effect.tap((inputs) =>
          Effect.sync(() => {
            expect(inputs.get).toEqual(projectId);
            expect(inputs.preview).toEqual(projectId);
            expect(inputs.apply).toEqual({
              projectId,
              expectedPreviewToken: "sha256:retention-preview",
            });
          }),
        ),
      );
    }),
);

it.effect("serves bounded census and note inspection through the knowledge service", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    const censusInput = yield* Ref.make<KnowledgeService.CivilizationCensusPageInput | null>(null);
    const notesInput = yield* Ref.make<KnowledgeService.CivilizationNotesPageInput | null>(null);
    const noteReadInput = yield* Ref.make<{
      readonly projectId: ProjectId;
      readonly noteId: CivilizationNoteId;
    } | null>(null);
    const projectId = ProjectId.make("project:civilization:http-knowledge");
    const noteId = CivilizationNoteId.make("note:http-knowledge");
    const knowledge = KnowledgeService.CivilizationKnowledgeService.of({
      ...fakeKnowledge,
      listCensus: (input) =>
        Ref.set(censusInput, input).pipe(
          Effect.as({
            projectId,
            revision: 3,
            citizens: [],
            nextCursor: CivilizationCensusCursor.make("census-next"),
            partial: true,
          }),
        ),
      listNotes: (input) =>
        Ref.set(notesInput, input).pipe(
          Effect.as({
            projectId,
            revision: 5,
            notes: [],
            nextCursor: CivilizationNotesCursor.make("notes-next"),
            partial: true,
          }),
        ),
      readNoteBody: (input) =>
        Ref.set(noteReadInput, input).pipe(
          Effect.as({
            noteId,
            projectId,
            category: "fact",
            bodyBytes: 5,
            authorThreadId: ThreadId.make("thread:civilization:http-knowledge"),
            authorEpoch: 1,
            acceptedRuntimeMode: "approval-required" as const,
            acceptedInteractionMode: "default" as const,
            revision: 1,
            createdAt: "2026-10-16T09:00:00.000Z",
            updatedAt: "2026-10-16T09:00:00.000Z",
            resolvedAt: null,
            body: "hello",
            sourceReferences: [],
          }),
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(
            adoptionCalls,
            ["orchestration:read", "orchestration:operate", "settings:write"],
            knowledge,
          ),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          const census = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/census?projectId=${encodeURIComponent(projectId)}&limit=2`,
            ),
            requestContext,
          );
          expect(census.status).toBe(200);
          expect(await census.json()).toMatchObject({ revision: 3, nextCursor: "census-next" });

          const notes = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/notes?projectId=${encodeURIComponent(projectId)}&limit=4&includeResolved=true`,
            ),
            requestContext,
          );
          expect(notes.status).toBe(200);
          expect(await notes.json()).toMatchObject({ revision: 5, nextCursor: "notes-next" });

          const note = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/notes/${encodeURIComponent(noteId)}?projectId=${encodeURIComponent(projectId)}`,
            ),
            requestContext,
          );
          expect(note.status).toBe(200);
          expect(await note.json()).toMatchObject({ noteId, body: "hello" });
        }),
      (server) => Effect.promise(() => server.dispose()),
    ).pipe(
      Effect.andThen(
        Effect.all({
          census: Ref.get(censusInput),
          notes: Ref.get(notesInput),
          note: Ref.get(noteReadInput),
        }),
      ),
      Effect.tap((inputs) =>
        Effect.sync(() => {
          expect(inputs.census).toEqual({ projectId, cursor: undefined, limit: 2 });
          expect(inputs.notes).toEqual({
            projectId,
            cursor: undefined,
            limit: 4,
            includeResolved: true,
          });
          expect(inputs.note).toEqual({ projectId, noteId });
        }),
      ),
    );
  }),
);

it.effect(
  "serves retained admin mail list and raw body only through the administrative boundary",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const projectId = ProjectId.make("project:civilization:http-mail");
      const messageId = CivilizationMessageId.make("mail:http-admin");
      const listInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly cursor?: string;
        readonly limit?: number;
      } | null>(null);
      const readInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly messageId: CivilizationMessageId;
      } | null>(null);
      const summary = {
        messageId,
        senderThreadId: ThreadId.make("thread:sender"),
        senderNameAtSend: "Ada",
        senderCitizenEpoch: 2,
        senderRunId: RunId.make("run:sender"),
        recipientThreadId: ThreadId.make("thread:recipient"),
        recipientDeliveryEpoch: 4,
        replyToMessageId: null,
        bodyBytes: 5,
        acceptedRuntimeMode: "approval-required" as const,
        acceptedInteractionMode: "default" as const,
        acceptedEnvironmentRevision: 3,
        acceptedProjectRevision: 5,
        acceptedAt: "2026-10-16T10:00:00.000Z",
        expiresAt: "2026-11-15T10:00:00.000Z",
        terminalRetentionDays: 30,
        firstOfferedAt: "2026-10-16T10:01:00.000Z",
        lastOfferedAt: "2026-10-16T10:01:00.000Z",
        offerCount: 1,
        acknowledgedAt: null,
        terminalAt: "2026-10-16T10:02:00.000Z",
        terminalReason: "recipient_archived" as const,
      };
      const mail = MailService.CivilizationMailService.of({
        ...fakeMail,
        listAdminMail: (input) =>
          Ref.set(listInput, input).pipe(
            Effect.as({
              projectId,
              revision: 7,
              messages: [summary],
              nextCursor: CivilizationInboxCursor.make("mail-next"),
              partial: true,
            }),
          ),
        readAdminMessage: (input) =>
          Ref.set(readInput, input).pipe(Effect.as({ projectId, ...summary, body: "hello" })),
      });

      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read", "orchestration:operate", "settings:write"],
              fakeKnowledge,
              mail,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const list = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/inbox?projectId=${encodeURIComponent(projectId)}&limit=2&cursor=mail-cursor`,
              ),
              requestContext,
            );
            expect(list.status).toBe(200);
            expect(await list.json()).toMatchObject({
              projectId,
              revision: 7,
              nextCursor: "mail-next",
              partial: true,
              messages: [{ messageId, terminalReason: "recipient_archived" }],
            });

            const read = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/inbox/${encodeURIComponent(messageId)}?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(read.status).toBe(200);
            expect(await read.json()).toMatchObject({ projectId, messageId, body: "hello" });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(Effect.all({ list: Ref.get(listInput), read: Ref.get(readInput) })),
        Effect.tap((inputs) =>
          Effect.sync(() => {
            expect(inputs.list).toEqual({ projectId, cursor: "mail-cursor", limit: 2 });
            expect(inputs.read).toEqual({ projectId, messageId });
          }),
        ),
      );
    }),
);

it.effect(
  "commits config and triggers all-existing adoption only after the authoritative commit",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(adoptionCalls, [
              "orchestration:read",
              "orchestration:operate",
              "settings:write",
            ]),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const status = await server.handler(
              new Request("http://127.0.0.1/api/civilization/status"),
              requestContext,
            );
            expect(status.status).toBe(200);
            expect(await status.json()).toMatchObject({
              status: "disabled",
              environmentRevision: 0,
            });

            const committed = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: true, adoption: "all_existing" },
                },
              }),
              requestContext,
            );
            expect(committed.status).toBe(200);

            const stale = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: false },
                },
              }),
              requestContext,
            );
            expect(stale.status).toBe(409);
            expect(await stale.json()).toMatchObject({
              code: "civilization_conflict",
              scope: "environment",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(Ref.get(adoptionCalls)),
        Effect.tap((count) => Effect.sync(() => expect(count).toBe(1))),
      );
    }),
);
