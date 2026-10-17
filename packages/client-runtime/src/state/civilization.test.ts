import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationContextInspectionId,
  CivilizationMessageId,
  CivilizationNoteId,
  CivilizationConfigConflictError,
  CivilizationDefaultConfig,
  CivilizationConfigDescription,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type CivilizationCapabilitiesResult,
  type CivilizationEffectiveConfig,
  type CivilizationStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  applyEnvironmentCivilizationCitizenReassignment,
  applyEnvironmentCivilizationPurgeBatch,
  applyEnvironmentCivilizationRetentionReduction,
  diffEnvironmentCivilizationConfig,
  exportEnvironmentCivilizationProjectData,
  exportEnvironmentCivilizationConfig,
  fetchEnvironmentCivilizationCensusPage,
  fetchEnvironmentCivilizationCapabilities,
  fetchEnvironmentCivilizationConfig,
  fetchEnvironmentCivilizationConfigDescription,
  fetchEnvironmentCivilizationContextInspectionDetail,
  fetchEnvironmentCivilizationContextInspectionPage,
  fetchEnvironmentCivilizationNoteBody,
  fetchEnvironmentCivilizationNotesPage,
  fetchEnvironmentCivilizationOverview,
  fetchEnvironmentCivilizationRetentionPolicy,
  fetchEnvironmentCivilizationRetainedMailBody,
  fetchEnvironmentCivilizationRetainedMailPage,
  fetchEnvironmentCivilizationStatus,
  importEnvironmentCivilizationConfig,
  previewEnvironmentCivilizationCitizenReassignment,
  previewEnvironmentCivilizationPurge,
  previewEnvironmentCivilizationRetentionReduction,
  reclaimEnvironmentCivilizationCitizenTitle,
  resetEnvironmentCivilizationConfig,
  restoreEnvironmentCivilizationCitizenTitle,
  setEnvironmentCivilizationConfig,
  validateEnvironmentCivilizationConfig,
} from "./civilization.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-civilization"),
  label: "Civilization test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test/ws",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};
const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-civilization-relay"),
  label: "Civilization relay environment",
});
const PROJECT_ID = ProjectId.make("project:civilization-ui");
const CAPABILITY = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  support: "full",
  contextInjection: true,
  keyedContextReplacement: true,
  actionablePromptRefresh: true,
  providerContinuationRefresh: true,
  messaging: true,
} as const;
const STATUS = {
  status: "active",
  environmentRevision: 2,
  projectRevision: 3,
  citizenCount: 5,
  openCitizenCount: 4,
  providerCapabilities: [CAPABILITY],
} satisfies CivilizationStatus;
const CAPABILITIES = { providers: [CAPABILITY] } satisfies CivilizationCapabilitiesResult;
const DESCRIPTION = {
  version: CIVILIZATION_CONFIG_VERSION,
  inheritance: "built-in defaults -> environment override -> project override",
  applicationTiming: {
    participation: "immediate",
    identities: "enrollment",
    personalities: "next input",
    messaging: "future checks",
    retention: "explicit cleanup",
  },
  limits: { packetBytes: 16_384 },
} satisfies typeof CivilizationConfigDescription.Type;
const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 2,
  projectRevision: 3,
  provenance: [{ path: "participation.enabled", source: "project" }],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

function responseFor(url: string) {
  const parsed = new URL(url);
  switch (parsed.pathname) {
    case "/api/civilization/status":
      return Response.json(STATUS);
    case "/api/civilization/capabilities":
      return Response.json(CAPABILITIES);
    case "/api/civilization/config/describe":
      return Response.json(DESCRIPTION);
    case "/api/civilization/config":
      return Response.json(EFFECTIVE);
    default:
      return new Response("not found", { status: 404 });
  }
}

describe("Civilization environment HTTP reads", () => {
  it.effect("keeps context-inspection metadata and sensitive detail on separate requests", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const inspectionId = CivilizationContextInspectionId.make(
        "context-inspection:client-runtime",
      );
      const threadId = ThreadId.make("thread:civilization:client-runtime-inspection");
      const runId = RunId.make("run:civilization:client-runtime-inspection");
      const attemptId = RunAttemptId.make("attempt:civilization:client-runtime-inspection");
      const providerInstanceId = ProviderInstanceId.make("codex-main");
      const fetchFn: typeof fetch = async (request) => {
        const url = String(request);
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === "/api/civilization/context-inspections") {
          return Response.json({
            projectId: PROJECT_ID,
            inspections: [],
            nextCursor: null,
            partial: false,
          });
        }
        if (
          parsed.pathname ===
          `/api/civilization/context-inspections/${encodeURIComponent(inspectionId)}`
        ) {
          return Response.json(null);
        }
        return new Response("not found", { status: 404 });
      };
      const auth = {
        prepared: PREPARED,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      };
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      yield* provide(
        fetchEnvironmentCivilizationContextInspectionPage({
          ...auth,
          projectId: PROJECT_ID,
          threadId,
          providerInstanceId,
          outcome: "provider_start_accepted",
          runId,
          attemptId,
          providerTurnOrdinal: 2,
          limit: 25,
        }),
      );
      expect(calls).toHaveLength(1);
      const listUrl = new URL(calls[0]!);
      expect(listUrl.pathname).toBe("/api/civilization/context-inspections");
      expect(listUrl.searchParams.get("projectId")).toBe(PROJECT_ID);
      expect(listUrl.searchParams.get("threadId")).toBe(threadId);
      expect(listUrl.searchParams.get("providerInstanceId")).toBe(providerInstanceId);
      expect(listUrl.searchParams.get("outcome")).toBe("provider_start_accepted");
      expect(listUrl.searchParams.get("runId")).toBe(runId);
      expect(listUrl.searchParams.get("attemptId")).toBe(attemptId);
      expect(listUrl.searchParams.get("providerTurnOrdinal")).toBe("2");
      expect(listUrl.searchParams.get("limit")).toBe("25");

      yield* provide(
        fetchEnvironmentCivilizationContextInspectionDetail({
          ...auth,
          projectId: PROJECT_ID,
          inspectionId,
        }),
      );
      expect(calls).toHaveLength(2);
      expect(new URL(calls[1]!).pathname).toBe(
        `/api/civilization/context-inspections/${encodeURIComponent(inspectionId)}`,
      );
    }),
  );
  it.effect("uses the authenticated environment client and preserves project scope", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const fetchFn: typeof fetch = async (request, init) => {
        calls.push({ url: String(request), init: init ?? {} });
        return responseFor(String(request));
      };
      const input = {
        prepared: PREPARED,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
        projectId: PROJECT_ID,
      };

      expect(
        yield* fetchEnvironmentCivilizationStatus(input).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      ).toEqual(STATUS);
      expect(
        yield* fetchEnvironmentCivilizationConfig(input).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      ).toEqual(EFFECTIVE);
      expect(
        yield* fetchEnvironmentCivilizationCapabilities(input).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      ).toEqual(CAPABILITIES);
      expect(
        yield* fetchEnvironmentCivilizationConfigDescription(input).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      ).toEqual(DESCRIPTION);

      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/civilization/status",
        "/api/civilization/config",
        "/api/civilization/capabilities",
        "/api/civilization/config/describe",
      ]);
      expect(new URL(calls[0]!.url).searchParams.get("projectId")).toBe(PROJECT_ID);
      expect(new URL(calls[1]!.url).searchParams.get("projectId")).toBe(PROJECT_ID);
      expect(new URL(calls[2]!.url).search).toBe("");
      expect(new URL(calls[3]!.url).search).toBe("");
      expect(calls.every((call) => call.init.method === "GET")).toBe(true);
      expect(calls.every((call) => call.init.credentials === "include")).toBe(true);
    }),
  );

  it.effect("loads the UI overview through the same four bounded authenticated reads", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const fetchFn: typeof fetch = async (request) => {
        calls.push(String(request));
        return responseFor(String(request));
      };

      const result = yield* fetchEnvironmentCivilizationOverview({
        prepared: PREPARED,
        projectId: PROJECT_ID,
        timeoutMs: 1234,
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      expect(result).toEqual({
        status: STATUS,
        capabilities: CAPABILITIES,
        description: DESCRIPTION,
        effective: EFFECTIVE,
      });
      expect(calls).toHaveLength(4);
      expect(calls.map((url) => new URL(url).pathname).sort()).toEqual(
        [
          "/api/civilization/capabilities",
          "/api/civilization/config",
          "/api/civilization/config/describe",
          "/api/civilization/status",
        ].sort(),
      );
    }),
  );

  it.effect("preserves bearer authorization without cookie credentials", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const prepared: PreparedConnection = {
        ...PREPARED,
        httpAuthorization: { _tag: "Bearer", token: "civilization-bearer" },
      };
      const fetchFn: typeof fetch = async (request, init) => {
        calls.push({ url: String(request), init: init ?? {} });
        return Response.json(STATUS);
      };

      yield* fetchEnvironmentCivilizationStatus({
        prepared,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      expect(calls).toHaveLength(1);
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer civilization-bearer",
      );
      expect(calls[0]!.init.credentials).toBeUndefined();
    }),
  );

  it.effect("uses a request-bound DPoP proof and refreshed relay origin", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const prepared: PreparedConnection = {
        environmentId: RELAY_TARGET.environmentId,
        label: RELAY_TARGET.label,
        httpBaseUrl: "https://stale-relay.example.test",
        socketUrl: "wss://relay.example.test/ws",
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "stale-token",
          expiresAtEpochMs: 0,
        },
        target: RELAY_TARGET,
      };
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("civilization-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "civilization-proof";
          }),
      });
      const remoteAuthorization = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("unexpected bearer authorization"),
        authorizeDpop: () => Effect.die("unexpected websocket authorization"),
        authorizeDpopHttp: () =>
          Effect.succeed({
            environmentId: RELAY_TARGET.environmentId,
            label: RELAY_TARGET.label,
            httpBaseUrl: "https://current-relay.example.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "current-token",
              expiresAtEpochMs: 3_600_000,
            },
          }),
      });
      const fetchFn: typeof fetch = async (request, init) => {
        calls.push({ url: String(request), init: init ?? {} });
        return Response.json(STATUS);
      };

      yield* fetchEnvironmentCivilizationStatus({
        prepared,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
        projectId: PROJECT_ID,
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        `https://current-relay.example.test/api/civilization/status?projectId=${encodeURIComponent(PROJECT_ID)}`,
      );
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("authorization")).toBe("DPoP current-token");
      expect(headers.get("dpop")).toBe("civilization-proof");
      expect(proofs).toEqual([
        {
          method: "GET",
          url: calls[0]!.url,
          accessToken: "current-token",
        },
      ]);
    }),
  );
});

describe("Civilization environment config commands", () => {
  it.effect(
    "uses the contract paths and payloads for validate, diff, set, reset, import, and export",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const fetchFn: typeof fetch = async (request, init) => {
          const url = String(request);
          calls.push({ url, init: init ?? {} });
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/validate")) {
            return Response.json({ valid: true, effective: EFFECTIVE });
          }
          if (pathname.endsWith("/diff")) {
            return Response.json({
              changes: [{ path: "participation.enabled", before: false, after: true }],
              effective: EFFECTIVE,
            });
          }
          if (pathname.endsWith("/export")) {
            return Response.json({
              json: JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION }),
              effective: EFFECTIVE,
            });
          }
          return Response.json({ revision: 4, effective: EFFECTIVE });
        };
        const override = {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
        } as const;
        const auth = {
          prepared: PREPARED,
          signer: Option.none(),
          remoteAuthorization: Option.none(),
          projectId: PROJECT_ID,
        };

        yield* validateEnvironmentCivilizationConfig({ ...auth, override }).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        );
        yield* diffEnvironmentCivilizationConfig({ ...auth, override }).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        );
        yield* setEnvironmentCivilizationConfig({ ...auth, expectedRevision: 3, override }).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        );
        yield* resetEnvironmentCivilizationConfig({ ...auth, expectedRevision: 3 }).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        );
        yield* importEnvironmentCivilizationConfig({
          ...auth,
          expectedRevision: 3,
          json: JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION }),
        }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));
        yield* exportEnvironmentCivilizationConfig(auth).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        );

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          "/api/civilization/config/validate",
          "/api/civilization/config/diff",
          "/api/civilization/config/set",
          "/api/civilization/config/reset",
          "/api/civilization/config/import",
          "/api/civilization/config/export",
        ]);
        expect(calls.map((call) => call.init.method)).toEqual([
          "POST",
          "POST",
          "POST",
          "POST",
          "POST",
          "GET",
        ]);
        expect(calls.every((call) => call.init.credentials === "include")).toBe(true);

        const bodies = calls.slice(0, 5).map((call) => JSON.parse(String(call.init.body)));
        expect(bodies).toEqual([
          { projectId: PROJECT_ID, override },
          { projectId: PROJECT_ID, override },
          { projectId: PROJECT_ID, expectedRevision: 3, override },
          { projectId: PROJECT_ID, expectedRevision: 3 },
          {
            projectId: PROJECT_ID,
            expectedRevision: 3,
            json: JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION }),
          },
        ]);
        expect(new URL(calls[5]!.url).searchParams.get("projectId")).toBe(PROJECT_ID);
      }),
  );

  it.effect("keeps a typed stale-revision conflict inspectable without retrying", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fetchFn: typeof fetch = async () => {
        calls += 1;
        return Response.json(
          {
            _tag: "CivilizationConfigConflictError",
            code: "civilization_conflict",
            scope: "project",
            expectedRevision: 3,
            currentRevision: 4,
          },
          { status: 409 },
        );
      };

      const error = yield* setEnvironmentCivilizationConfig({
        prepared: PREPARED,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
        projectId: PROJECT_ID,
        expectedRevision: 3,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
        },
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);

      expect(error).toBeInstanceOf(CivilizationConfigConflictError);
      expect(error).toMatchObject({
        scope: "project",
        expectedRevision: 3,
        currentRevision: 4,
      });
      expect(calls).toBe(1);
    }),
  );
});

describe("Civilization project inspection and citizen administration", () => {
  it.effect(
    "uses metadata-list, body-on-demand, and citizen-admin contract paths without prefetching bodies",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const threadId = ThreadId.make("thread:civilization-ui");
        const noteId = CivilizationNoteId.make("note:civilization-ui");
        const messageId = CivilizationMessageId.make("mail:civilization-ui");
        const citizen = {
          threadId,
          projectId: PROJECT_ID,
          name: "Ada",
          profileId: "calm",
          profileLabel: "Calm",
          generation: 1,
          lineageStatus: "resolved",
          parentThreadId: null,
          relationshipToParent: null,
          observedOnly: false,
          epoch: 2,
          closed: false,
          deleted: false,
          titleManaged: true,
          revision: 7,
        } as const;
        const note = {
          noteId,
          projectId: PROJECT_ID,
          category: "fact",
          bodyBytes: 12,
          authorThreadId: threadId,
          authorEpoch: 2,
          acceptedRuntimeMode: "full-access",
          acceptedInteractionMode: "default",
          revision: 5,
          createdAt: "2026-10-16T18:00:00.000Z",
          updatedAt: "2026-10-16T18:01:00.000Z",
          resolvedAt: null,
        } as const;
        const mail = {
          messageId,
          senderThreadId: threadId,
          senderNameAtSend: "Ada",
          senderCitizenEpoch: 2,
          senderRunId: "run:civilization-ui",
          recipientThreadId: threadId,
          recipientDeliveryEpoch: 3,
          replyToMessageId: null,
          bodyBytes: 9,
          acceptedRuntimeMode: "full-access",
          acceptedInteractionMode: "default",
          acceptedEnvironmentRevision: 2,
          acceptedProjectRevision: 3,
          acceptedAt: "2026-10-16T18:00:00.000Z",
          expiresAt: "2026-10-17T18:00:00.000Z",
          terminalRetentionDays: 30,
          firstOfferedAt: null,
          lastOfferedAt: null,
          offerCount: 0,
          acknowledgedAt: null,
          terminalAt: null,
          terminalReason: null,
        } as const;
        const fetchFn: typeof fetch = async (request, init) => {
          const url = String(request);
          calls.push({ url, init: init ?? {} });
          const pathname = new URL(url).pathname;
          switch (pathname) {
            case "/api/civilization/census":
              return Response.json({
                projectId: PROJECT_ID,
                revision: 11,
                citizens: [citizen],
                nextCursor: null,
                partial: false,
              });
            case "/api/civilization/notes":
              return Response.json({
                projectId: PROJECT_ID,
                revision: 12,
                notes: [note],
                nextCursor: null,
                partial: false,
              });
            case `/api/civilization/notes/${encodeURIComponent(noteId)}`:
              return Response.json({ ...note, body: "note body", sourceReferences: [] });
            case "/api/civilization/inbox":
              return Response.json({
                projectId: PROJECT_ID,
                revision: 13,
                messages: [mail],
                nextCursor: null,
                partial: false,
              });
            case `/api/civilization/inbox/${encodeURIComponent(messageId)}`:
              return Response.json({ projectId: PROJECT_ID, ...mail, body: "mail body" });
            case "/api/civilization/citizens/reassignment/preview":
              return Response.json({
                threadId,
                citizenRevision: 7,
                environmentRevision: 2,
                projectRevision: 3,
                current: {
                  nameEntryId: "ada",
                  name: "Ada",
                  profileEntryId: "calm",
                  profileLabel: "Calm",
                },
                proposed: {
                  nameEntryId: "grace",
                  name: "Grace",
                  profileEntryId: "calm",
                  profileLabel: "Calm",
                },
              });
            case "/api/civilization/citizens/reassignment/apply":
              return Response.json({ ...citizen, name: "Grace", revision: 8 });
            case "/api/civilization/citizens/title/restore":
            case "/api/civilization/citizens/title/reclaim":
              return Response.json({ citizen, changed: true, threadTitle: "[Ada] topic" });
            default:
              return new Response("not found", { status: 404 });
          }
        };
        const auth = {
          prepared: PREPARED,
          signer: Option.none(),
          remoteAuthorization: Option.none(),
        };
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

        yield* provide(
          fetchEnvironmentCivilizationCensusPage({ ...auth, projectId: PROJECT_ID, limit: 25 }),
        );
        yield* provide(
          fetchEnvironmentCivilizationNotesPage({
            ...auth,
            projectId: PROJECT_ID,
            limit: 10,
            includeResolved: true,
          }),
        );
        yield* provide(
          fetchEnvironmentCivilizationRetainedMailPage({
            ...auth,
            projectId: PROJECT_ID,
            limit: 10,
          }),
        );

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          "/api/civilization/census",
          "/api/civilization/notes",
          "/api/civilization/inbox",
        ]);

        yield* provide(
          fetchEnvironmentCivilizationNoteBody({ ...auth, projectId: PROJECT_ID, noteId }),
        );
        yield* provide(
          fetchEnvironmentCivilizationRetainedMailBody({
            ...auth,
            projectId: PROJECT_ID,
            messageId,
          }),
        );
        const reassignment = {
          threadId,
          projectId: PROJECT_ID,
          expectedCitizenRevision: 7,
          expectedEnvironmentRevision: 2,
          expectedProjectRevision: 3,
          nameEntryId: "grace",
        };
        yield* provide(
          previewEnvironmentCivilizationCitizenReassignment({ ...auth, request: reassignment }),
        );
        yield* provide(
          applyEnvironmentCivilizationCitizenReassignment({ ...auth, request: reassignment }),
        );
        const titleRequest = { threadId, projectId: PROJECT_ID, expectedCitizenRevision: 7 };
        yield* provide(
          restoreEnvironmentCivilizationCitizenTitle({ ...auth, request: titleRequest }),
        );
        yield* provide(
          reclaimEnvironmentCivilizationCitizenTitle({ ...auth, request: titleRequest }),
        );

        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          "/api/civilization/census",
          "/api/civilization/notes",
          "/api/civilization/inbox",
          `/api/civilization/notes/${encodeURIComponent(noteId)}`,
          `/api/civilization/inbox/${encodeURIComponent(messageId)}`,
          "/api/civilization/citizens/reassignment/preview",
          "/api/civilization/citizens/reassignment/apply",
          "/api/civilization/citizens/title/restore",
          "/api/civilization/citizens/title/reclaim",
        ]);
        expect(calls.slice(0, 5).every((call) => call.init.method === "GET")).toBe(true);
        expect(calls.slice(5).every((call) => call.init.method === "POST")).toBe(true);
        expect(calls.every((call) => call.init.credentials === "include")).toBe(true);
        expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("25");
        expect(new URL(calls[1]!.url).searchParams.get("includeResolved")).toBe("true");
      }),
  );
});

describe("Civilization project data and retention operations", () => {
  it.effect("uses exact export, retention, and purge contract paths and preview tokens", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const fetchFn: typeof fetch = async (request, init) => {
        const url = String(request);
        calls.push({ url, init: init ?? {} });
        switch (new URL(url).pathname) {
          case "/api/civilization/export":
            return Response.json({
              schemaVersion: 1,
              projectId: PROJECT_ID,
              exportedAt: "2026-10-16T18:00:00.000Z",
              environmentRevision: 2,
              projectRevision: 3,
              effectiveConfig: CivilizationDefaultConfig,
              limitations: {
                mode: "inspection_backup_only",
                inspectionBackupOnly: true,
                restorable: false,
                excluded: ["provider transcripts"],
              },
              citizens: [],
              notes: [],
              mail: [],
            });
          case "/api/civilization/retention":
            return Response.json({
              noteRetentionDays: 30,
              diagnosticRetentionDays: 7,
              tombstoneRetentionDays: 30,
            });
          case "/api/civilization/retention/preview":
            return Response.json({
              projectId: PROJECT_ID,
              previewToken: "retention-preview-token",
              environmentRevision: 2,
              projectRevision: 3,
              current: {
                noteRetentionDays: 30,
                diagnosticRetentionDays: 7,
                tombstoneRetentionDays: 30,
              },
              configured: {
                noteRetentionDays: 7,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 14,
              },
              proposed: {
                noteRetentionDays: 7,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 14,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 32,
                diagnosticReferences: 1,
                diagnosticInspections: 1,
                tombstones: 1,
              },
              samples: {
                noteIds: ["note:old"],
                contextReferenceIds: ["context:old"],
                contextInspectionIds: ["inspection:old"],
                tombstoneThreadIds: ["thread:old"],
                partial: false,
              },
              warnings: ["Cleanup is irreversible."],
            });
          case "/api/civilization/retention/apply":
            return Response.json({
              projectId: PROJECT_ID,
              applied: {
                noteRetentionDays: 7,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 14,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 32,
                diagnosticReferences: 1,
                diagnosticInspections: 1,
                tombstones: 1,
              },
            });
          case "/api/civilization/purge/preview":
            return Response.json({
              projectId: PROJECT_ID,
              previewToken: "purge-preview-token",
              environmentRevision: 2,
              projectRevision: 3,
              censusRevision: 4,
              notesRevision: 5,
              mailRevision: 6,
              counts: {
                citizens: 1,
                notes: 2,
                noteBodyBytes: 32,
                messages: 3,
                messageBodyBytes: 64,
                contextReferences: 4,
                contextInspections: 7,
                receipts: 5,
                quotaWindows: 6,
                projectConfigRows: 1,
                projectStateRows: 1,
              },
              limitations: {
                mode: "inspection_backup_only",
                inspectionBackupOnly: true,
                restorable: false,
                excluded: ["provider transcripts", "external backups"],
              },
              warnings: ["This does not erase provider transcripts."],
            });
          case "/api/civilization/purge/apply":
            return Response.json({
              projectId: PROJECT_ID,
              complete: false,
              deletedThisBatch: 50,
              remaining: 10,
              progressState: "in_progress",
              purgeStartedAt: "2026-10-16T18:00:00.000Z",
              purgeCompletedAt: null,
            });
          default:
            return new Response("not found", { status: 404 });
        }
      };
      const auth = {
        prepared: PREPARED,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
        projectId: PROJECT_ID,
      };
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      yield* provide(exportEnvironmentCivilizationProjectData(auth));
      yield* provide(fetchEnvironmentCivilizationRetentionPolicy(auth));
      yield* provide(previewEnvironmentCivilizationRetentionReduction(auth));
      yield* provide(
        applyEnvironmentCivilizationRetentionReduction({
          ...auth,
          expectedPreviewToken: "retention-preview-token",
        }),
      );
      yield* provide(previewEnvironmentCivilizationPurge(auth));
      yield* provide(
        applyEnvironmentCivilizationPurgeBatch({
          prepared: PREPARED,
          signer: Option.none(),
          remoteAuthorization: Option.none(),
          request: {
            projectId: PROJECT_ID,
            expectedPreviewToken: "purge-preview-token",
            batchSize: 50,
          },
        }),
      );

      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/civilization/export",
        "/api/civilization/retention",
        "/api/civilization/retention/preview",
        "/api/civilization/retention/apply",
        "/api/civilization/purge/preview",
        "/api/civilization/purge/apply",
      ]);
      expect(calls.map((call) => call.init.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "POST",
        "GET",
        "POST",
      ]);
      expect(calls.every((call) => call.init.credentials === "include")).toBe(true);
      expect(JSON.parse(String(calls[3]!.init.body))).toEqual({
        projectId: PROJECT_ID,
        expectedPreviewToken: "retention-preview-token",
      });
      expect(JSON.parse(String(calls[5]!.init.body))).toEqual({
        projectId: PROJECT_ID,
        expectedPreviewToken: "purge-preview-token",
        batchSize: 50,
      });
    }),
  );
});
