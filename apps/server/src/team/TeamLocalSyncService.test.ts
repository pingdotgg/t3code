import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  DEFAULT_MODEL,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TeamSyncLocalThreadInput,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { localSyncMirroredMessageId, localSyncMirroredRunId } from "./TeamLocalSyncService.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

const makeLocalSyncTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const config = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-team-local-sync-test-",
  }).pipe(Layer.provideMerge(platform));
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(config));
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
  const authSessions = AuthSessions.layer.pipe(Layer.provide(persistence));
  const serverEnv = ServerEnvironment.layer.pipe(Layer.provide(secrets), Layer.provide(config));
  const sessions = SessionStore.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(persistence, secrets, authSessions, serverEnv)),
    Layer.provide(config),
  );
  const eventStore = EventStoreV2.layer.pipe(Layer.provideMerge(persistence));
  const projectionStore = ProjectionStoreV2.layer.pipe(Layer.provideMerge(persistence));
  const eventSink = EventSink.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(eventStore, projectionStore, persistence)),
  );
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(sessions),
    Layer.provideMerge(secrets),
    Layer.provideMerge(serverEnv),
    Layer.provideMerge(config),
  );
  return Layer.mergeAll(teamService, eventSink, projectionStore, persistence);
};

function makePayload(
  overrides: Partial<TeamSyncLocalThreadInput> & {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly executionEnvironmentId: EnvironmentId;
    readonly updatedAt: string;
  },
): TeamSyncLocalThreadInput {
  return {
    title: "Local Thread",
    branch: "main",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), DEFAULT_MODEL),
    createdAt: "2026-11-26T12:00:00.000Z",
    runs: [
      {
        id: "run-1",
        ordinal: 1,
        status: "running",
        userMessageId: "msg-user-1",
        createdAt: "2026-11-26T12:00:00.000Z",
        completedAt: null,
      },
    ],
    messages: [
      {
        id: "msg-user-1",
        role: "user",
        text: "Hello",
        runId: "run-1",
        createdAt: "2026-11-26T12:00:00.000Z",
        updatedAt: "2026-11-26T12:00:00.000Z",
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        text: "Initial response",
        runId: "run-1",
        createdAt: "2026-11-26T12:00:01.000Z",
        updatedAt: overrides.updatedAt,
      },
    ],
    ...overrides,
  };
}

describe("TeamService.syncLocalThread security & concurrency hardening", () => {
  it.effect(
    "P1-1: enforces persisted lock and restricted view restrictions against regular creator local sync",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;

        const aliceSession = yield* sessions.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobJoined = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: { label: "Bob", deviceType: "desktop", os: "linux" },
        });
        const bobSessionRows = yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM team_session_meta WHERE member_id = ${bobJoined.member.id} LIMIT 1
        `;
        const bobSessionId = AuthSessionId.make(bobSessionRows[0]!.session_id);

        const projectId = ProjectId.make("proj-local-sync-p1-1");
        yield* team.assignProject({
          sessionId: aliceSession.sessionId,
          payload: { projectId, defaultViewId: null },
        });

        const bobLocalEnvId = EnvironmentId.make("env-bob-laptop");
        const threadId = ThreadId.make("thread-bob-local-1");

        // 1. Bob creates & syncs a local thread into Default view (allowed).
        yield* team.syncLocalThread({
          sessionId: bobSessionId,
          payload: makePayload({
            threadId,
            projectId,
            executionEnvironmentId: bobLocalEnvId,
            updatedAt: "2026-11-26T12:01:00.000Z",
          }),
          eventSink,
          projectionStore,
        });

        // 2. Admin Alice locks Bob's local-synced thread.
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId, locked: true },
        });

        // 3. Regular Bob attempts to sync an update (even passing locked: false & defaultViewId) -> FORBIDDEN!
        const lockedAttempt = yield* Effect.exit(
          team.syncLocalThread({
            sessionId: bobSessionId,
            payload: makePayload({
              threadId,
              projectId,
              executionEnvironmentId: bobLocalEnvId,
              viewId: init.team.defaultViewId,
              locked: false,
              updatedAt: "2026-11-26T12:02:00.000Z",
              messages: [
                {
                  id: "msg-user-1",
                  role: "user",
                  text: "Hello",
                  runId: "run-1",
                  createdAt: "2026-11-26T12:00:00.000Z",
                  updatedAt: "2026-11-26T12:00:00.000Z",
                },
                {
                  id: "msg-asst-1",
                  role: "assistant",
                  text: "Bypassed lock!",
                  runId: "run-1",
                  createdAt: "2026-11-26T12:00:01.000Z",
                  updatedAt: "2026-11-26T12:02:00.000Z",
                },
              ],
            }),
            eventSink,
            projectionStore,
          }),
        );
        expect(Exit.isFailure(lockedAttempt)).toBe(true);
        const projAfterLock = yield* projectionStore.getThreadProjection(threadId);
        const asstAfterLock = projAfterLock.messages.find(
          (m) => m.id === localSyncMirroredMessageId(threadId, "msg-asst-1"),
        );
        expect(asstAfterLock?.text).toBe("Initial response");

        // 4. Alice unlocks the thread and moves it into an admin-only View.
        const adminOnlyView = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Admin Only",
            readRule: { roles: ["owner", "admin"], memberIds: [] },
            postRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId, locked: false },
        });
        yield* team.setThreadView({
          sessionId: aliceSession.sessionId,
          payload: { threadId, viewId: adminOnlyView.id },
        });

        // 5. Regular Bob attempts to sync an update (passing defaultViewId) -> FORBIDDEN!
        const viewRestrictedAttempt = yield* Effect.exit(
          team.syncLocalThread({
            sessionId: bobSessionId,
            payload: makePayload({
              threadId,
              projectId,
              executionEnvironmentId: bobLocalEnvId,
              viewId: init.team.defaultViewId,
              updatedAt: "2026-11-26T12:03:00.000Z",
              messages: [
                {
                  id: "msg-user-1",
                  role: "user",
                  text: "Hello",
                  runId: "run-1",
                  createdAt: "2026-11-26T12:00:00.000Z",
                  updatedAt: "2026-11-26T12:00:00.000Z",
                },
                {
                  id: "msg-asst-1",
                  role: "assistant",
                  text: "Bypassed admin-only view!",
                  runId: "run-1",
                  createdAt: "2026-11-26T12:00:01.000Z",
                  updatedAt: "2026-11-26T12:03:00.000Z",
                },
              ],
            }),
            eventSink,
            projectionStore,
          }),
        );
        expect(Exit.isFailure(viewRestrictedAttempt)).toBe(true);
        const projAfterView = yield* projectionStore.getThreadProjection(threadId);
        const asstAfterView = projAfterView.messages.find(
          (m) => m.id === localSyncMirroredMessageId(threadId, "msg-asst-1"),
        );
        expect(asstAfterView?.text).toBe("Initial response");

        // 6. Owner Alice syncing her own locked local thread remains permitted.
        const aliceThreadId = ThreadId.make("thread-alice-local-locked");
        const aliceLocalEnvId = EnvironmentId.make("env-alice-laptop");
        yield* team.syncLocalThread({
          sessionId: aliceSession.sessionId,
          payload: makePayload({
            threadId: aliceThreadId,
            projectId,
            executionEnvironmentId: aliceLocalEnvId,
            locked: true,
            updatedAt: "2026-11-26T12:04:00.000Z",
          }),
          eventSink,
          projectionStore,
        });
        yield* team.syncLocalThread({
          sessionId: aliceSession.sessionId,
          payload: makePayload({
            threadId: aliceThreadId,
            projectId,
            executionEnvironmentId: aliceLocalEnvId,
            updatedAt: "2026-11-26T12:05:00.000Z",
            messages: [
              {
                id: "msg-user-1",
                role: "user",
                text: "Hello",
                runId: "run-1",
                createdAt: "2026-11-26T12:00:00.000Z",
                updatedAt: "2026-11-26T12:00:00.000Z",
              },
              {
                id: "msg-asst-1",
                role: "assistant",
                text: "Updated by admin owner",
                runId: "run-1",
                createdAt: "2026-11-26T12:00:01.000Z",
                updatedAt: "2026-11-26T12:05:00.000Z",
              },
            ],
          }),
          eventSink,
          projectionStore,
        });
        const aliceProj = yield* projectionStore.getThreadProjection(aliceThreadId);
        expect(
          aliceProj.messages.find(
            (m) => m.id === localSyncMirroredMessageId(aliceThreadId, "msg-asst-1"),
          )?.text,
        ).toBe("Updated by admin owner");
      }).pipe(Effect.scoped, Effect.provide(makeLocalSyncTestLayer())),
  );

  it.effect(
    "P1-4: ignores delayed/out-of-order snapshots, prevents terminal run regression, and serializes concurrent syncs",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;

        const aliceSession = yield* sessions.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        const projectId = ProjectId.make("proj-local-sync-p1-4");
        yield* team.assignProject({
          sessionId: aliceSession.sessionId,
          payload: { projectId, defaultViewId: null },
        });

        const threadId = ThreadId.make("thread-alice-monotonic");
        const snapshot = (minute: number, seq: number, text: string, completed = false) => {
          const updatedAt = `2026-11-26T12:${String(minute).padStart(2, "0")}:00.000Z`;
          const payload = makePayload({
            threadId,
            projectId,
            executionEnvironmentId: EnvironmentId.make("env-alice-laptop"),
            updatedAt,
            syncSeq: NonNegativeInt.make(seq),
          });
          return {
            ...payload,
            title: text,
            runs: payload.runs.map((run) =>
              completed ? { ...run, status: "completed" as const, completedAt: updatedAt } : run,
            ),
            messages: payload.messages.map((message) =>
              message.role === "assistant" ? { ...message, text } : message,
            ),
          };
        };
        const sync = (payload: TeamSyncLocalThreadInput) =>
          team.syncLocalThread({
            sessionId: aliceSession.sessionId,
            payload,
            eventSink,
            projectionStore,
          });
        const assertMirror = Effect.fnUntraced(function* (text: string) {
          const projection = yield* projectionStore.getThreadProjection(threadId);
          expect(projection.thread.title).toBe(text);
          expect(
            projection.runs.find((run) => run.id === localSyncMirroredRunId(threadId, "run-1"))
              ?.status,
          ).toBe("completed");
          expect(
            projection.messages.find(
              (message) => message.id === localSyncMirroredMessageId(threadId, "msg-asst-1"),
            )?.text,
          ).toBe(text);
        });

        yield* sync(snapshot(10, 5, "Final answer", true));
        yield* sync(snapshot(5, 2, "Delayed snapshot"));
        yield* sync(snapshot(10, 3, "Stale snapshot with matching timestamp"));
        yield* assertMirror("Final answer");

        yield* Effect.all(
          [
            sync(snapshot(12, 7, "Newest concurrent snapshot", true)),
            sync(snapshot(11, 6, "Older concurrent snapshot")),
          ],
          { concurrency: "unbounded" },
        );
        yield* assertMirror("Newest concurrent snapshot");
      }).pipe(Effect.scoped, Effect.provide(makeLocalSyncTestLayer())),
  );
});
