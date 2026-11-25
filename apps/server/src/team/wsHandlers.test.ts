import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ALL_TEAM_ROLES,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthClientMetadata,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";
import {
  assertCanReadAssetResource,
  filterSearchThreadsResultForSession,
  filterShellSnapshotForSession,
  filterThreadRecordByReadableIds,
  guardThreadStreamForSession,
  withTeamShellAccessUpdates,
} from "./wsHandlers.ts";

const testClient: AuthClientMetadata = {
  deviceType: "desktop",
  label: "Test App",
};

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-ws-access-" }).pipe(
    Layer.provideMerge(platform),
  );
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
  const authDeps = Layer.mergeAll(
    persistence,
    ServerSecretStore.layer.pipe(Layer.provide(base)),
    AuthSessions.layer.pipe(Layer.provide(persistence)),
    ServerEnvironment.layer.pipe(
      Layer.provide(ServerSecretStore.layer.pipe(Layer.provide(base))),
      Layer.provide(base),
    ),
  );
  const sessions = SessionStore.layer.pipe(Layer.provideMerge(authDeps), Layer.provide(base));
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(sessions),
    Layer.provide(base),
  );
  return Layer.mergeAll(teamService, teamRepo, sessions, persistence);
};

const makeThreadShell = (threadId: ThreadId, title: string): OrchestrationV2ThreadShell =>
  ({
    id: threadId,
    projectId: ProjectId.make("proj-1"),
    title,
  }) as unknown as OrchestrationV2ThreadShell;

describe("Team WS access enforcement helpers", () => {
  it.effect(
    "filters shell snapshots, search results, thread records, assets, and revokes live shell & thread streams on view narrowing",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice" });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Access Team", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobSession = yield* sessions.verify(bobRedeemed.accessToken);

        const staffOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Staff Only",
            readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });

        const publicThreadId = ThreadId.make("thread-public-1");
        const secretThreadId = ThreadId.make("thread-secret-1");
        yield* team.prepareThreadAttribution({
          sessionId: aliceSession.sessionId,
          threadId: publicThreadId,
        });
        yield* team.prepareThreadAttribution({
          sessionId: aliceSession.sessionId,
          threadId: secretThreadId,
          viewId: staffOnly.id,
        });

        const fullSnapshot = {
          snapshotSequence: 10,
          projects: [],
          threads: [
            makeThreadShell(publicThreadId, "Public thread"),
            makeThreadShell(secretThreadId, "Secret thread"),
          ],
          archivedThreads: [],
        } as unknown as OrchestrationV2ShellSnapshot;

        // 1. Shell snapshot filtering hides Staff Only thread from Bob, keeps both for Alice.
        const bobSnapshot = yield* filterShellSnapshotForSession(
          team,
          bobSession.sessionId,
          fullSnapshot,
        );
        expect(bobSnapshot.threads.map((t) => t.id)).toEqual([publicThreadId]);

        const aliceSnapshot = yield* filterShellSnapshotForSession(
          team,
          aliceSession.sessionId,
          fullSnapshot,
        );
        expect(aliceSnapshot.threads.map((t) => t.id)).toEqual([publicThreadId, secretThreadId]);

        // 2. Search results and thread records exclude restricted threads for Bob.
        const searchResult = {
          matches: [
            { threadId: publicThreadId, title: "Public" },
            { threadId: secretThreadId, title: "Secret" },
          ],
          threads: fullSnapshot.threads,
          hasMore: false,
        } as unknown as OrchestrationV2SearchThreadsResult;
        const bobSearch = yield* filterSearchThreadsResultForSession(
          team,
          bobSession.sessionId,
          searchResult,
        );
        expect(bobSearch.matches.map((m) => m.threadId)).toEqual([publicThreadId]);
        expect(bobSearch.threads?.map((t) => t.id)).toEqual([publicThreadId]);

        const bobTitles = yield* filterThreadRecordByReadableIds(team, bobSession.sessionId, {
          [publicThreadId]: "Public thread",
          [secretThreadId]: "Secret thread",
        });
        expect(bobTitles).toEqual({ [publicThreadId]: "Public thread" });

        // 3. Asset resource check denies restricted thread files & attachments for Bob.
        yield* assertCanReadAssetResource(team, bobSession.sessionId, {
          _tag: "workspace-file",
          threadId: publicThreadId,
          path: "README.md",
        });
        const bobAssetDenied = yield* Effect.exit(
          assertCanReadAssetResource(team, bobSession.sessionId, {
            _tag: "workspace-file",
            threadId: secretThreadId,
            path: "SECRET.md",
          }),
        );
        expect(bobAssetDenied._tag).toBe("Failure");
        if (bobAssetDenied._tag === "Failure") {
          expect(Cause.squash(bobAssetDenied.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
        }

        // 4. Live shell stream and active thread stream immediately drop/fail when publicThreadId moves to Staff Only.
        const shellQueue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const threadQueue = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const shellReady = yield* Deferred.make<void>();
        const threadReady = yield* Deferred.make<void>();

        yield* Queue.offer(shellQueue, { kind: "snapshot", snapshot: fullSnapshot });
        yield* Queue.offer(threadQueue, { kind: "synchronized" });

        const bobShellFiber = yield* withTeamShellAccessUpdates(
          team,
          bobSession.sessionId,
          () => filterShellSnapshotForSession(team, bobSession.sessionId, fullSnapshot),
          Stream.fromQueue(shellQueue),
        ).pipe(
          Stream.tap(() => Deferred.succeed(shellReady, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

        const bobThreadFiber = yield* guardThreadStreamForSession(
          team,
          bobSession.sessionId,
          publicThreadId,
          Stream.fromQueue(threadQueue),
        ).pipe(
          Stream.tap(() => Deferred.succeed(threadReady, undefined)),
          Stream.runDrain,
          Effect.exit,
          Effect.forkChild,
        );

        yield* Deferred.await(shellReady);
        yield* Deferred.await(threadReady);
        // Yield once after both streams have pulled their initial items so the right-hand accessChanges PubSub subscriptions are active.
        yield* Effect.yieldNow;

        // Move publicThreadId to Staff Only -> Bob's shell stream receives fresh snapshot with 0 threads
        // and Bob's active thread stream immediately terminates with EnvironmentAuthorizationError.
        yield* team.setThreadView({
          sessionId: aliceSession.sessionId,
          payload: { threadId: publicThreadId, viewId: staffOnly.id },
        });

        const pushedShellItems = yield* Fiber.join(bobShellFiber);
        expect(pushedShellItems).toHaveLength(2);
        const initialShellItem = pushedShellItems[0]!;
        expect(initialShellItem.kind).toBe("snapshot");
        if (initialShellItem.kind === "snapshot") {
          expect(initialShellItem.snapshot.threads.map((t) => t.id)).toEqual([publicThreadId]);
        }
        const revokedShellItem = pushedShellItems[1]!;
        expect(revokedShellItem.kind).toBe("snapshot");
        if (revokedShellItem.kind === "snapshot") {
          expect(revokedShellItem.snapshot.threads).toEqual([]);
        }

        const threadExit = yield* Fiber.join(bobThreadFiber);
        expect(threadExit._tag).toBe("Failure");
        if (threadExit._tag === "Failure") {
          expect(Cause.squash(threadExit.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
        }

        // Re-widening Staff Only readRule to include regular restores Bob's read access.
        yield* team.updateView({
          sessionId: aliceSession.sessionId,
          payload: {
            viewId: staffOnly.id,
            readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
          },
        });
        expect(yield* team.canReadThread(bobSession.sessionId, publicThreadId)).toBe(true);
        // Sanity check unused import avoided:
        expect(EnvironmentId.make("env-1")).toBe("env-1");
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
