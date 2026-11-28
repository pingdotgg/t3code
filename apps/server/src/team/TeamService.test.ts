// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local mock GitHub API server for TeamService GitHub identity tests.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ALL_TEAM_ROLES,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthRelayWriteScope,
  AuthSessionId,
  AuthStandardClientScopes,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  TeamMemberId,
  ThreadId,
  effectiveTeamThreadNoteHash,
  type AuthClientMetadata,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ScheduledTask,
  type TeamStateStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { localSyncMirroredMessageId, localSyncMirroredRunId } from "./TeamLocalSyncService.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";
import { recordTeamDispatchEvents, recordTeamThreadLaunch } from "./wsHandlers.ts";

const testClient: AuthClientMetadata = {
  deviceType: "desktop",
  label: "Test App",
};

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-test-" }).pipe(
    Layer.provideMerge(platform),
  );
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
  const secretStore = ServerSecretStore.layer.pipe(Layer.provide(base));
  const authDeps = Layer.mergeAll(
    persistence,
    secretStore,
    AuthSessions.layer.pipe(Layer.provide(persistence)),
    ServerEnvironment.layer.pipe(Layer.provide(secretStore), Layer.provide(base)),
  );
  const sessions = SessionStore.layer.pipe(Layer.provideMerge(authDeps), Layer.provide(base));
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const assetsRepo = TeamAssetsRepository.layer.pipe(Layer.provide(persistence));
  const githubRepo = TeamGitHubRepository.layer.pipe(
    Layer.provide(persistence),
    Layer.provide(secretStore),
  );
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(assetsRepo),
    Layer.provideMerge(githubRepo),
    Layer.provideMerge(sessions),
    Layer.provideMerge(secretStore),
    Layer.provide(base),
  );
  return Layer.mergeAll(teamService, teamRepo, assetsRepo, githubRepo, sessions, persistence);
};

describe("TeamService", () => {
  it.effect("operates as a no-op in personal mode when no team is configured", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const repo = yield* TeamRepository.TeamRepository;
      const sessionId = AuthSessionId.make("personal-session-1");

      const state = yield* team.getState(sessionId);
      expect(state).toEqual({
        team: null,
        currentMember: null,
        members: [],
        views: [],
        invites: [],
        threadAttributions: [],
        followedThreadIds: [],
        threadSnoozes: [],
        latestTurnAttributions: [],
        teamProjects: [],
        environments: [],
        threadNotes: [],
        providers: [],
        skills: [],
        preprompts: [],
        assetsRevision: 0,
        myGitHubIdentity: null,
        automationGitHubIdentity: null,
        githubAppConfig: null,
        scheduledTaskMetas: [],
      });

      const threadId = ThreadId.make("thread-personal-1");
      yield* team.recordThreadCreated({ sessionId, threadId });
      yield* team.recordTurnAuthored({ sessionId, threadId, turnId: "turn-1" });
      expect(Option.isNone(yield* repo.getThreadAttribution(threadId))).toBe(true);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "initializes team, enforces modo+ invite role ceiling, role-scoped sessions, unique pseudos, and server-authoritative attribution",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;

        const ownerSession = yield* sessions.issue({ subject: "owner-browser" });
        const init = yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Acme Engineering", ownerPseudo: "Alice" },
        });
        expect(init.team.name).toBe("Acme Engineering");
        expect(init.owner.pseudo).toBe("Alice");
        expect(init.owner.role).toBe("owner");

        // Owner creates an invite for a regular member with prefilled pseudo "bob".
        const bobInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob", maxUses: 1 },
        });
        expect(bobInvite.invite.prefilledPseudo).toBe("bob");
        expect(bobInvite.token.startsWith("t3team_")).toBe(true);

        const preview = yield* team.previewInvite(bobInvite.token);
        expect(preview.teamName).toBe("Acme Engineering");
        expect(preview.role).toBe("regular");
        expect(preview.prefilledPseudo).toBe("bob");

        // Case-insensitive pseudo collision with owner "Alice" is rejected WITHOUT consuming the invite.
        const collisionExit = yield* Effect.exit(
          team.redeemInvite({
            token: bobInvite.token,
            pseudo: "alice",
            client: testClient,
          }),
        );
        expect(collisionExit._tag).toBe("Failure");

        // Valid redemption creates Bob and binds his new session in team_session_meta.
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        expect(bobRedeemed.member.pseudo).toBe("bob");
        expect(bobRedeemed.member.role).toBe("regular");
        // Regular members must NOT receive administrative access/relay/maintain scopes.
        expect(bobRedeemed.scopes).toContain(AuthOrchestrationOperateScope);
        expect(bobRedeemed.scopes).not.toContain(AuthAccessWriteScope);
        expect(bobRedeemed.scopes).not.toContain(AuthAccessReadScope);
        expect(bobRedeemed.scopes).not.toContain(AuthRelayWriteScope);
        expect(bobRedeemed.scopes).not.toContain(AuthEnvironmentMaintainScope);

        const bobVerified = yield* sessions.verify(bobRedeemed.accessToken);
        const bobBinding = yield* repo.getSessionBinding(bobVerified.sessionId);
        expect(Option.isSome(bobBinding)).toBe(true);
        expect(Option.getOrThrow(bobBinding).memberId).toBe(bobRedeemed.member.id);

        // One-time invite cannot be redeemed twice.
        const secondRedeem = yield* Effect.exit(
          team.redeemInvite({
            token: bobInvite.token,
            pseudo: "charlie",
            client: testClient,
          }),
        );
        expect(secondRedeem._tag).toBe("Failure");

        // Regular member Bob cannot create invites.
        const bobCreateInvite = yield* Effect.exit(
          team.createInvite({
            sessionId: bobVerified.sessionId,
            payload: { role: "regular" },
          }),
        );
        expect(bobCreateInvite._tag).toBe("Failure");

        // Owner creates a modo invite for Charlie; Charlie can invite regular/modo but NOT admin.
        const modoInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "modo", prefilledPseudo: "charlie" },
        });
        const charlieRedeemed = yield* team.redeemInvite({
          token: modoInvite.token,
          pseudo: "charlie",
          client: testClient,
        });
        expect(charlieRedeemed.scopes).not.toContain(AuthAccessWriteScope);
        const charlieVerified = yield* sessions.verify(charlieRedeemed.accessToken);

        const charlieAdminInvite = yield* Effect.exit(
          team.createInvite({
            sessionId: charlieVerified.sessionId,
            payload: { role: "admin" },
          }),
        );
        expect(charlieAdminInvite._tag).toBe("Failure");

        const charlieModoInvite = yield* team.createInvite({
          sessionId: charlieVerified.sessionId,
          payload: { role: "modo" },
        });
        expect(charlieModoInvite.invite.role).toBe("modo");

        // Owner creates an admin invite for Dana; admin retains access:write scope.
        const adminInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "admin", prefilledPseudo: "dana" },
        });
        const danaRedeemed = yield* team.redeemInvite({
          token: adminInvite.token,
          pseudo: "dana",
          client: testClient,
        });
        expect(danaRedeemed.scopes).toContain(AuthAccessWriteScope);

        // Revoking an invite prevents redemption.
        const revokeResult = yield* team.revokeInvite({
          sessionId: charlieVerified.sessionId,
          payload: { inviteId: charlieModoInvite.invite.id },
        });
        expect(revokeResult.revoked).toBe(true);
        const revokedRedeem = yield* Effect.exit(
          team.redeemInvite({
            token: charlieModoInvite.token,
            pseudo: "eve",
            client: testClient,
          }),
        );
        expect(revokedRedeem._tag).toBe("Failure");

        // Updating Bob's pseudo updates attribution dynamically without mutating thread titles.
        const bobThreadId = ThreadId.make("thread-bob-1");
        yield* team.recordThreadCreated({
          sessionId: bobVerified.sessionId,
          threadId: bobThreadId,
        });
        const renamedBob = yield* team.updateMyPseudo({
          sessionId: bobVerified.sessionId,
          payload: { pseudo: "bob_dev" },
        });
        expect(renamedBob.pseudo).toBe("bob_dev");
        const bobAttrAfter = Option.getOrThrow(yield* repo.getThreadAttribution(bobThreadId));
        expect(bobAttrAfter.creatorPseudo).toBe("bob_dev");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("enforces singleton workspace under concurrent initializeTeam calls", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const sessions = yield* SessionStore.SessionStore;
      const sessionA = yield* sessions.issue({ subject: "owner-a" });
      const sessionB = yield* sessions.issue({ subject: "owner-b" });

      const [exitA, exitB] = yield* Effect.all(
        [
          Effect.exit(
            team.initializeTeam({
              sessionId: sessionA.sessionId,
              payload: { name: "Team A", ownerPseudo: "alice" },
            }),
          ),
          Effect.exit(
            team.initializeTeam({
              sessionId: sessionB.sessionId,
              payload: { name: "Team B", ownerPseudo: "bob" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const successes = [exitA, exitB].filter((exit) => exit._tag === "Success");
      const failures = [exitA, exitB].filter((exit) => exit._tag === "Failure");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const failureError = Cause.squash(failures[0]!.cause);
      expect(failureError).toMatchObject({
        _tag: "TeamOperationError",
        code: "already_configured",
      });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces expiry atomically in SQL and allows only one winner on concurrent single-use redemption",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const ownerSession = yield* sessions.issue({ subject: "owner-concurrent" });
        yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Race Team", ownerPseudo: "alice" },
        });

        // Concurrent single-use invite redemption: exactly one succeeds.
        const singleInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", maxUses: 1 },
        });
        const [r1, r2] = yield* Effect.all(
          [
            Effect.exit(
              team.redeemInvite({ token: singleInvite.token, pseudo: "bob", client: testClient }),
            ),
            Effect.exit(
              team.redeemInvite({
                token: singleInvite.token,
                pseudo: "charlie",
                client: testClient,
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect([r1, r2].filter((exit) => exit._tag === "Success")).toHaveLength(1);
        expect([r1, r2].filter((exit) => exit._tag === "Failure")).toHaveLength(1);

        // Expired invite is rejected atomically by SQL predicate even if called directly.
        const expiringInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", maxUses: 1 },
        });
        const pastIso = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 5 }));
        yield* sql`
          UPDATE team_invites SET expires_at = ${pastIso} WHERE id = ${expiringInvite.invite.id}
        `;
        const expiredRedeem = yield* Effect.exit(
          team.redeemInvite({ token: expiringInvite.token, pseudo: "dave", client: testClient }),
        );
        expect(expiredRedeem._tag).toBe("Failure");

        const consumedDirectly = yield* repo.consumeInviteAndCreateMember({
          inviteId: expiringInvite.invite.id,
          nowIso: DateTime.formatIso(yield* DateTime.now),
          member: {
            id: (yield* team.getState(ownerSession.sessionId)).members[0]!.id,
            teamId: expiringInvite.invite.teamId,
            pseudo: "dave",
            role: "regular",
            status: "active",
            createdAt: pastIso,
            updatedAt: pastIso,
          },
        });
        expect(consumedDirectly).toBe(false);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "rolls back invite consumption and member creation if session issuance fails so retry succeeds",
    () =>
      Effect.gen(function* () {
        const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
        const base = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-rollback-" }).pipe(
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
        const realSessionsLayer = SessionStore.layer.pipe(
          Layer.provideMerge(authDeps),
          Layer.provide(base),
        );
        let failNextIssue = false;
        const flakySessionsLayer = Layer.effect(
          SessionStore.SessionStore,
          Effect.gen(function* () {
            const inner = yield* SessionStore.SessionStore;
            return SessionStore.SessionStore.of({
              ...inner,
              issue: (input) => {
                if (failNextIssue) {
                  failNextIssue = false;
                  return Effect.fail(
                    new SessionStore.SessionCredentialIssueError({
                      cause: new Error("simulated session store failure"),
                    }),
                  );
                }
                return inner.issue(input);
              },
            });
          }),
        ).pipe(Layer.provide(realSessionsLayer));

        const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
        const teamLayer = TeamService.layer.pipe(
          Layer.provideMerge(teamRepo),
          Layer.provideMerge(flakySessionsLayer),
          Layer.provide(base),
        );

        yield* Effect.gen(function* () {
          const team = yield* TeamService.TeamService;
          const sessions = yield* SessionStore.SessionStore;
          const ownerSession = yield* sessions.issue({ subject: "owner" });
          yield* team.initializeTeam({
            sessionId: ownerSession.sessionId,
            payload: { name: "Rollback Team", ownerPseudo: "alice" },
          });
          const invite = yield* team.createInvite({
            sessionId: ownerSession.sessionId,
            payload: { role: "regular", maxUses: 1 },
          });

          // First attempt fails during session issuance and must roll back member + invite use.
          failNextIssue = true;
          const firstExit = yield* Effect.exit(
            team.redeemInvite({ token: invite.token, pseudo: "bob", client: testClient }),
          );
          expect(firstExit._tag).toBe("Failure");

          // Retry with the same one-time invite token and same pseudo succeeds cleanly.
          const retry = yield* team.redeemInvite({
            token: invite.token,
            pseudo: "bob",
            client: testClient,
          });
          expect(retry.member.pseudo).toBe("bob");
        }).pipe(Effect.provide(teamLayer));
      }),
  );

  it.effect(
    "streams live team updates and restricts inviteUpserted events to active modo+ sessions",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const ownerSession = yield* sessions.issue({ subject: "owner-stream" });
        yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Stream Team", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobVerified = yield* sessions.verify(bobRedeemed.accessToken);

        const ownerEventsFiber = yield* team
          .streamState(ownerSession.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        const bobEventsFiber = yield* team
          .streamState(bobVerified.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        // Give subscribers a microtask turn to attach, then publish an invite and a thread attribution.
        yield* Effect.yieldNow;
        yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular" },
        });
        yield* team.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId: ThreadId.make("thread-stream-1"),
        });

        const ownerEvents: ReadonlyArray<TeamStateStreamEvent> =
          yield* Fiber.join(ownerEventsFiber);
        const bobEvents: ReadonlyArray<TeamStateStreamEvent> = yield* Fiber.join(bobEventsFiber);

        expect(ownerEvents.map((event) => event.type)).toEqual(["snapshot", "inviteUpserted"]);
        // Bob (regular) must skip inviteUpserted and receive only snapshot + threadAttributed.
        expect(bobEvents.map((event) => event.type)).toEqual(["snapshot", "threadAttributed"]);

        // Suspended owner/modo session must not receive inviteUpserted either.
        const modoInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "modo" },
        });
        const charlieRedeemed = yield* team.redeemInvite({
          token: modoInvite.token,
          pseudo: "charlie",
          client: testClient,
        });
        const charlieVerified = yield* sessions.verify(charlieRedeemed.accessToken);
        yield* sql`UPDATE team_members SET status = 'suspended' WHERE id = ${charlieRedeemed.member.id}`;

        const suspendedFiber = yield* team
          .streamState(charlieVerified.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular" },
        });
        yield* team.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId: ThreadId.make("thread-stream-2"),
        });
        yield* team.updateMyPseudo({
          sessionId: ownerSession.sessionId,
          payload: { pseudo: "alice-updated" },
        });
        const suspendedEvents = yield* Fiber.join(suspendedFiber);
        // Suspended members must skip inviteUpserted and unseen restricted threads (no threadRemoved ID leak).
        expect(suspendedEvents.map((event) => event.type)).toEqual(["snapshot", "memberUpserted"]);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "records thread, initial run, multi-member steering prompts, and MCP child thread inheritance",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;

        const ownerSession = yield* sessions.issue({ subject: "owner-attr" });
        const init = yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Attr Team", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobVerified = yield* sessions.verify(bobRedeemed.accessToken);

        // 1. launchThread records both thread creator AND initial run/message author.
        const launchedThreadId = ThreadId.make("thread-launched-1");
        const initialRunId = RunId.make("run-initial-1");
        const initialMsgId = MessageId.make("msg-initial-1");
        const fakeProjection = {
          runs: [{ id: initialRunId }],
          messages: [{ id: initialMsgId, role: "user" }],
        } as unknown as OrchestrationV2ThreadProjection;

        yield* recordTeamThreadLaunch(team, ownerSession.sessionId, {
          threadId: launchedThreadId,
          projection: fakeProjection,
          resumed: false,
        });

        const launchedAttr = Option.getOrThrow(yield* repo.getThreadAttribution(launchedThreadId));
        expect(launchedAttr.creatorMemberId).toBe(init.owner.id);

        // 2. Bob sends a steering prompt (message.updated, no new run.created) on Alice's thread.
        const steeringEvent = {
          type: "message.updated",
          payload: {
            id: MessageId.make("msg-steer-2"),
            threadId: launchedThreadId,
            role: "user",
          },
        } as unknown as OrchestrationV2DomainEvent;
        yield* recordTeamDispatchEvents(team, bobVerified.sessionId, [{ event: steeringEvent }]);

        const turns = yield* repo.listTurnAttributionsForThread(launchedThreadId);
        expect(turns.map((turn) => [turn.turnId, turn.authorMemberId, turn.authorPseudo])).toEqual([
          [initialRunId, init.owner.id, "alice"],
          [`msg:${initialMsgId}`, init.owner.id, "alice"],
          ["msg:msg-steer-2", bobRedeemed.member.id, "bob"],
        ]);

        // 3. MCP-launched child thread inherits creatorMemberId from parent thread.
        const childThreadId = ThreadId.make("thread-mcp-child-1");
        yield* team.recordThreadInheritedFromParent({
          parentThreadId: launchedThreadId,
          threadId: childThreadId,
          turnId: "run-child-1",
        });
        const childAttr = Option.getOrThrow(yield* repo.getThreadAttribution(childThreadId));
        expect(childAttr.creatorMemberId).toBe(init.owner.id);
        expect(childAttr.creatorPseudo).toBe("alice");
        const childTurns = yield* repo.listTurnAttributionsForThread(childThreadId);
        expect(childTurns.map((turn) => [turn.turnId, turn.authorMemberId])).toEqual([
          ["run-child-1", init.owner.id],
        ]);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("isolates snoozes on a followed locked thread across team members and devices", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const repo = yield* TeamRepository.TeamRepository;
      const sessions = yield* SessionStore.SessionStore;
      const charlie = yield* sessions.issue({ subject: "charlie" });
      const { team: workspace, owner } = yield* team.initializeTeam({
        sessionId: charlie.sessionId,
        payload: { name: "Snooze Team", ownerPseudo: "charlie" },
      });
      const join = (pseudo: string, role: "regular" | "modo" | "admin" | "owner") =>
        Effect.gen(function* () {
          const invite = yield* team.createInvite({
            sessionId: charlie.sessionId,
            payload: { role },
          });
          const redeemed = yield* team.redeemInvite({
            token: invite.token,
            pseudo,
            client: testClient,
          });
          return { member: redeemed.member, session: yield* sessions.verify(redeemed.accessToken) };
        });
      const alice = yield* join("alice", "regular");
      const bob = yield* join("bob", "regular");
      const modo = yield* join("modo", "modo");
      const admin = yield* join("admin", "admin");
      const otherOwner = yield* join("owner", "owner");
      const aliceMobile = yield* sessions.issue({ subject: "alice-mobile" });
      const now = yield* DateTime.now;
      yield* repo.bindSession({
        sessionId: aliceMobile.sessionId,
        teamId: workspace.id,
        memberId: alice.member.id,
        boundAt: DateTime.formatIso(now),
      });
      const readOnly = yield* team.createView({
        sessionId: charlie.sessionId,
        payload: {
          name: "Read only",
          readRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
          postRule: { roles: ["owner"], memberIds: [] },
        },
      });
      const threadId = ThreadId.make("locked-runner-thread");
      yield* repo.recordThreadAttribution({
        threadId,
        teamId: workspace.id,
        creatorMemberId: owner.id,
        viewId: readOnly.id,
        locked: true,
        lockedByMemberId: owner.id,
        executionEnvironmentId: EnvironmentId.make("unavailable-runner"),
        createdAt: DateTime.formatIso(now),
      });
      const payload = {
        threadId,
        snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
      };
      expect(
        (yield* team
          .snoozeThread({ sessionId: alice.session.sessionId, payload })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
      for (const { session } of [alice, bob, modo, admin, otherOwner]) {
        const input = { sessionId: session.sessionId, payload: { threadId } };
        expect((yield* team.followThread(input)).isFollowing).toBe(true);
        if (session !== alice.session && session !== bob.session) {
          expect((yield* team.unfollowThread(input)).isFollowing).toBe(false);
        }
      }

      const snooze = yield* team.snoozeThread({ sessionId: alice.session.sessionId, payload });
      const mobileActor = { kind: "session" as const, sessionId: aliceMobile.sessionId };
      expect(yield* team.listActorThreadSnoozes(mobileActor, [threadId])).toEqual([snooze]);
      expect((yield* team.getState(alice.session.sessionId)).threadSnoozes).toEqual([snooze]);
      expect((yield* team.getState(bob.session.sessionId)).threadSnoozes).toEqual([]);
      expect((yield* team.getState(charlie.sessionId)).threadSnoozes).toEqual([]);
      expect(
        new Set((yield* team.listNotificationRecipientsForThread({ threadId })).recipientMemberIds),
      ).toEqual(new Set([owner.id, bob.member.id]));
      yield* team.bindRelayRecipientForSession({
        sessionId: alice.session.sessionId,
        cloudUserId: "alice",
      });
      expect(
        yield* team.shouldPublishRelayNotificationForThread({ threadId, cloudUserId: "alice" }),
      ).toBe(false);
      expect(
        yield* team.shouldPublishRelayQueuedMessageNotification!({
          threadId,
          recipientMemberIds: [alice.member.id, bob.member.id],
          cloudUserId: "alice",
        }),
      ).toBe(false);
      yield* team.bindRelayRecipientForSession({
        sessionId: bob.session.sessionId,
        cloudUserId: "bob",
      });
      expect(
        yield* team.shouldPublishRelayNotificationForThread({ threadId, cloudUserId: "bob" }),
      ).toBe(true);
      expect(
        yield* team.shouldPublishRelayQueuedMessageNotification!({
          threadId,
          recipientMemberIds: [alice.member.id, bob.member.id],
          cloudUserId: "bob",
        }),
      ).toBe(true);
      yield* team.unsnoozeThread({ sessionId: aliceMobile.sessionId, payload: { threadId } });
      expect(
        (yield* team.getState(alice.session.sessionId)).threadSnoozes?.[0]?.snoozedUntil,
      ).toBeNull();
      yield* team.snoozeThread({ sessionId: alice.session.sessionId, payload });
      yield* team.unfollowThread({ sessionId: alice.session.sessionId, payload: { threadId } });
      expect(yield* team.listActorThreadSnoozes(mobileActor, [threadId])).toEqual([]);
      expect((yield* team.getState(bob.session.sessionId)).followedThreadIds).toEqual([threadId]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "follows and unfollows threads idempotently, rejects invalid targets, syncs across sessions, and gates server notifications",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const ownerSession = yield* sessions.issue({ subject: "owner-follow" });
        const init = yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Follow Team", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobSession1 = yield* sessions.verify(bobRedeemed.accessToken);
        // Bind a second concurrent session for Bob (e.g. desktop + web) to verify cross-session sync.
        const bobSession2 = yield* sessions.issue({
          subject: `team-member:${bobRedeemed.member.id}`,
        });
        yield* repo.bindSession({
          sessionId: bobSession2.sessionId,
          teamId: init.team.id,
          memberId: bobRedeemed.member.id,
          boundAt: DateTime.formatIso(yield* DateTime.now),
        });

        const aliceThreadId = ThreadId.make("thread-alice-follow");
        const bobThreadId = ThreadId.make("thread-bob-follow");
        const missingThreadId = ThreadId.make("thread-does-not-exist");
        const otherTeamThreadId = ThreadId.make("thread-other-team");
        const personalLegacyThreadId = ThreadId.make("thread-legacy-unattributed");

        yield* team.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId: aliceThreadId,
        });
        yield* team.recordTurnAuthored({
          sessionId: ownerSession.sessionId,
          threadId: aliceThreadId,
          turnId: "run-alice-1",
        });
        yield* team.recordThreadCreated({
          sessionId: bobSession1.sessionId,
          threadId: bobThreadId,
        });
        yield* team.recordTurnAuthored({
          sessionId: bobSession1.sessionId,
          threadId: bobThreadId,
          turnId: "run-bob-1",
        });

        // Reject following own thread (prevents one-way UI dead end and count inflation).
        const ownThreadExit = yield* Effect.exit(
          team.followThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: bobThreadId },
          }),
        );
        expect(ownThreadExit._tag).toBe("Failure");
        if (ownThreadExit._tag === "Failure") {
          const failure = Cause.squash(ownThreadExit.cause) as { readonly code?: string };
          expect(failure.code).toBe("forbidden");
        }

        // Reject following a non-existent thread.
        const missingExit = yield* Effect.exit(
          team.followThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: missingThreadId },
          }),
        );
        expect(missingExit._tag).toBe("Failure");
        if (missingExit._tag === "Failure") {
          const failure = Cause.squash(missingExit.cause) as { readonly code?: string };
          expect(failure.code).toBe("not_found");
        }

        // Reject following a thread attributed to a different team.
        yield* sql`PRAGMA foreign_keys = OFF`;
        yield* sql`
          INSERT INTO team_thread_meta (thread_id, team_id, creator_member_id, view_id, locked, created_at)
          VALUES (${otherTeamThreadId}, 'team-foreign', ${init.owner.id}, 'view-foreign', 0, '2026-01-01T00:00:00.000Z')
        `;
        yield* sql`PRAGMA foreign_keys = ON`;
        const foreignExit = yield* Effect.exit(
          team.followThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: otherTeamThreadId },
          }),
        );
        expect(foreignExit._tag).toBe("Failure");
        if (foreignExit._tag === "Failure") {
          const failure = Cause.squash(foreignExit.cause) as { readonly code?: string };
          expect(failure.code).toBe("forbidden");
        }

        // Reject unbound sessions.
        const unboundSession = yield* sessions.issue({ subject: "anonymous" });
        const unboundExit = yield* Effect.exit(
          team.followThread({
            sessionId: unboundSession.sessionId,
            payload: { threadId: aliceThreadId },
          }),
        );
        expect(unboundExit._tag).toBe("Failure");

        // Initial notification gating before Bob follows Alice's thread:
        // - Alice (creator) notified
        // - Bob (non-following colleague) silenced
        // - Unattributed/personal thread untouched (notified)
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: init.owner.id,
            threadId: aliceThreadId,
            turnId: "run-alice-1",
          }),
        ).toBe(true);
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bobRedeemed.member.id,
            threadId: aliceThreadId,
            turnId: "run-alice-1",
          }),
        ).toBe(false);
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bobRedeemed.member.id,
            threadId: personalLegacyThreadId,
          }),
        ).toBe(true);
        // Without an explicit relay-to-member binding, team relay push fails closed (never guesses owner).
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(false);

        // Bind T3 Connect relay explicitly to Alice's session + cloud user ID.
        yield* team.bindRelayRecipientForSession({
          sessionId: ownerSession.sessionId,
          cloudUserId: "cloud-alice",
        });

        // Relay push for bound recipient (Alice): allowed on Alice's thread, silenced on Bob's unfollowed thread.
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(true);
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: bobThreadId,
            turnId: "run-bob-1",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(false);
        // Mismatched or missing cloud user ID fails closed when relay binding is tied to a cloud account.
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
            cloudUserId: "cloud-someone-else",
          }),
        ).toBe(false);
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
            cloudUserId: null,
          }),
        ).toBe(false);
        // Post-team unattributed threads fail closed; pre-team legacy threads stay allowed.
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: ThreadId.make("thread-post-team-unattributed"),
            threadCreatedAt: "2099-01-01T00:00:00.000Z",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(false);
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: personalLegacyThreadId,
            threadCreatedAt: "1969-12-31T23:59:59.000Z",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(true);

        // Subscribe Bob's second session and Alice's session to verify follow events stay member-scoped.
        const bobSession2Fiber = yield* team
          .streamState(bobSession2.sessionId)
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        const aliceFiber = yield* team
          .streamState(ownerSession.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;

        // Bob follows Alice's thread twice (idempotent: only one change event emitted).
        expect(
          yield* team.followThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: aliceThreadId },
          }),
        ).toEqual({ threadId: aliceThreadId, isFollowing: true });
        expect(
          yield* team.followThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: aliceThreadId },
          }),
        ).toEqual({ threadId: aliceThreadId, isFollowing: true });

        expect(yield* team.listFollowedThreads(bobSession1.sessionId)).toEqual([aliceThreadId]);
        expect((yield* team.getState(bobSession2.sessionId)).followedThreadIds).toEqual([
          aliceThreadId,
        ]);
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bobRedeemed.member.id,
            threadId: aliceThreadId,
            turnId: "run-alice-1",
          }),
        ).toBe(true);
        expect(
          yield* team.listNotificationRecipientsForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
          }),
        ).toEqual({
          isTeamThread: true,
          recipientMemberIds: [init.owner.id, bobRedeemed.member.id],
        });

        // Bob unfollows twice (idempotent).
        expect(
          yield* team.unfollowThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: aliceThreadId },
          }),
        ).toEqual({ threadId: aliceThreadId, isFollowing: false });
        expect(
          yield* team.unfollowThread({
            sessionId: bobSession1.sessionId,
            payload: { threadId: aliceThreadId },
          }),
        ).toEqual({ threadId: aliceThreadId, isFollowing: false });

        // Emit a non-follow event so Alice's stream can finish taking 2 items and prove she got no follow events.
        yield* team.recordTurnAuthored({
          sessionId: bobSession1.sessionId,
          threadId: aliceThreadId,
          turnId: "run-bob-in-alice-thread",
        });

        const bob2Events = yield* Fiber.join(bobSession2Fiber);
        const aliceEvents = yield* Fiber.join(aliceFiber);
        expect(bob2Events.map((event) => event.type)).toEqual([
          "snapshot",
          "threadFollowChanged",
          "threadFollowChanged",
        ]);
        expect(aliceEvents.map((event) => event.type)).toEqual(["snapshot", "turnAttributed"]);

        // After unfollowing, Bob is silenced for Alice's turn, but still notified for his own completing turn!
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bobRedeemed.member.id,
            threadId: aliceThreadId,
            turnId: "run-alice-1",
          }),
        ).toBe(false);
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bobRedeemed.member.id,
            threadId: aliceThreadId,
            turnId: "run-bob-in-alice-thread",
          }),
        ).toBe(true);

        // When bound relay recipient (Alice) follows Bob's thread, relay push notification unlocks for Bob's thread.
        yield* team.followThread({
          sessionId: ownerSession.sessionId,
          payload: { threadId: bobThreadId },
        });
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: bobThreadId,
            turnId: "run-bob-1",
            cloudUserId: "cloud-alice",
          }),
        ).toBe(true);

        // Multi-owner & relink: add second owner Dana and bind relay to Dana.
        const danaInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "owner", prefilledPseudo: "dana" },
        });
        const danaRedeemed = yield* team.redeemInvite({
          token: danaInvite.token,
          pseudo: "dana",
          client: testClient,
        });
        const danaSession = yield* sessions.verify(danaRedeemed.accessToken);
        const danaThreadId = ThreadId.make("thread-dana-owner");
        yield* team.recordThreadCreated({
          sessionId: danaSession.sessionId,
          threadId: danaThreadId,
        });
        yield* team.bindRelayRecipientForSession({
          sessionId: danaSession.sessionId,
          cloudUserId: "cloud-dana",
        });
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: aliceThreadId,
            turnId: "run-alice-1",
            cloudUserId: "cloud-dana",
          }),
        ).toBe(false);
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: danaThreadId,
            cloudUserId: "cloud-dana",
          }),
        ).toBe(true);
        yield* team.clearRelayRecipientBinding();
        expect(
          yield* team.shouldPublishRelayNotificationForThread({
            threadId: danaThreadId,
            cloudUserId: "cloud-dana",
          }),
        ).toBe(false);

        // Soft-deleted attributed thread cannot be followed and is excluded from listFollowedThreads.
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode,
            interaction_mode, active_provider_thread_id, created_at, updated_at,
            archived_at, deleted_at, payload_json
          ) VALUES (
            ${bobThreadId}, 'proj-1', 'Deleted Bob thread', 'codex', 'full-access',
            'default', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            NULL, '2026-01-02T00:00:00.000Z', '{}'
          )
        `;
        expect(yield* team.listFollowedThreads(ownerSession.sessionId)).not.toContain(bobThreadId);
        const deletedFollowExit = yield* Effect.exit(
          team.followThread({
            sessionId: danaSession.sessionId,
            payload: { threadId: bobThreadId },
          }),
        );
        expect(deletedFollowExit._tag).toBe("Failure");
        if (deletedFollowExit._tag === "Failure") {
          const failure = Cause.squash(deletedFollowExit.cause) as { readonly code?: string };
          expect(failure.code).toBe("not_found");
        }

        // Duplicate recordTurnAuthored for an existing turnId does NOT re-broadcast turnAttributed.
        const dupTurnFiber = yield* team
          .streamState(ownerSession.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* team.recordTurnAuthored({
          sessionId: bobSession1.sessionId,
          threadId: aliceThreadId,
          turnId: "run-bob-in-alice-thread",
        });
        yield* team.recordTurnAuthored({
          sessionId: bobSession1.sessionId,
          threadId: aliceThreadId,
          turnId: "run-bob-fresh-2",
        });
        const dupTurnEvents = yield* Fiber.join(dupTurnFiber);
        expect(dupTurnEvents.map((event) => event.type)).toEqual(["snapshot", "turnAttributed"]);
        const turnEvent = dupTurnEvents[1];
        if (turnEvent?.type === "turnAttributed") {
          expect(turnEvent.payload.turnId).toBe("run-bob-fresh-2");
        }

        // Snapshot retains active/non-terminal run attribution even when >5 newer turns are queued behind it.
        const activeBobRunId = "run-bob-active-held";
        yield* team.recordTurnAuthored({
          sessionId: bobSession1.sessionId,
          threadId: aliceThreadId,
          turnId: activeBobRunId,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            ${activeBobRunId}, ${aliceThreadId}, 1, 'codex', NULL,
            'running', '2026-01-01T00:00:00.000Z', NULL, '{}'
          )
        `;
        for (let i = 1; i <= 6; i += 1) {
          yield* team.recordTurnAuthored({
            sessionId: ownerSession.sessionId,
            threadId: aliceThreadId,
            turnId: `run-alice-queued-${i}`,
          });
        }
        const reconnectedSnapshot = yield* team.getState(bobSession1.sessionId);
        expect(
          reconnectedSnapshot.latestTurnAttributions.some(
            (turn) =>
              turn.turnId === activeBobRunId && turn.authorMemberId === bobRedeemed.member.id,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces RBAC role hierarchy, higher-role protection, last-owner protection, and session revocation on suspend/remove",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-owner" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "RBAC Team", ownerPseudo: "alice" },
        });
        const alice = init.owner;

        const inviteAndJoin = (pseudo: string, role: "admin" | "modo" | "regular") =>
          Effect.gen(function* () {
            const created = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role, prefilledPseudo: pseudo },
            });
            const redeemed = yield* team.redeemInvite({
              token: created.token,
              pseudo,
              client: testClient,
            });
            const verified = yield* sessions.verify(redeemed.accessToken);
            return { member: redeemed.member, token: redeemed.accessToken, session: verified };
          });

        const dana = yield* inviteAndJoin("dana", "admin");
        const charlie = yield* inviteAndJoin("charlie", "modo");
        const bob = yield* inviteAndJoin("bob", "regular");

        const expectErrorCode = <A, E>(effect: Effect.Effect<A, E>, code: string) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(effect);
            expect(exit._tag).toBe("Failure");
            if (exit._tag === "Failure") {
              expect(Cause.squash(exit.cause)).toMatchObject({
                _tag: "TeamOperationError",
                code,
              });
            }
          });

        // Regular member cannot change roles or member status.
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: bob.session.sessionId,
            payload: { memberId: bob.member.id, role: "modo" },
          }),
          "forbidden",
        );
        yield* expectErrorCode(
          team.updateMemberStatus({
            sessionId: bob.session.sessionId,
            payload: { memberId: charlie.member.id, status: "suspended" },
          }),
          "forbidden",
        );

        // Modo (Charlie) can promote Bob to modo, but cannot assign admin or modify admin/owner.
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: charlie.session.sessionId,
            payload: { memberId: bob.member.id, role: "admin" },
          }),
          "forbidden",
        );
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: charlie.session.sessionId,
            payload: { memberId: dana.member.id, role: "regular" },
          }),
          "forbidden",
        );
        yield* expectErrorCode(
          team.updateMemberStatus({
            sessionId: charlie.session.sessionId,
            payload: { memberId: dana.member.id, status: "suspended" },
          }),
          "forbidden",
        );
        const bobPromoted = yield* team.updateMemberRole({
          sessionId: charlie.session.sessionId,
          payload: { memberId: bob.member.id, role: "modo" },
        });
        expect(bobPromoted.role).toBe("modo");
        const bobDemoted = yield* team.updateMemberRole({
          sessionId: charlie.session.sessionId,
          payload: { memberId: bob.member.id, role: "regular" },
        });
        expect(bobDemoted.role).toBe("regular");

        // Admin (Dana) cannot promote to owner or modify owner.
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: dana.session.sessionId,
            payload: { memberId: charlie.member.id, role: "owner" },
          }),
          "forbidden",
        );
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: dana.session.sessionId,
            payload: { memberId: alice.id, role: "admin" },
          }),
          "forbidden",
        );

        // Last active owner cannot be demoted, suspended, or removed.
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: aliceSession.sessionId,
            payload: { memberId: alice.id, role: "admin" },
          }),
          "last_owner",
        );
        yield* expectErrorCode(
          team.updateMemberStatus({
            sessionId: aliceSession.sessionId,
            payload: { memberId: alice.id, status: "suspended" },
          }),
          "last_owner",
        );

        // Once Dana is promoted to owner, Alice can demote herself to admin; Dana as sole owner is then protected.
        const danaOwner = yield* team.updateMemberRole({
          sessionId: aliceSession.sessionId,
          payload: { memberId: dana.member.id, role: "owner" },
        });
        expect(danaOwner.role).toBe("owner");
        const aliceDemoted = yield* team.updateMemberRole({
          sessionId: aliceSession.sessionId,
          payload: { memberId: alice.id, role: "admin" },
        });
        expect(aliceDemoted.role).toBe("admin");
        yield* expectErrorCode(
          team.updateMemberRole({
            sessionId: dana.session.sessionId,
            payload: { memberId: dana.member.id, role: "admin" },
          }),
          "last_owner",
        );

        // Suspending Bob immediately revokes his active session.
        const bobSuspended = yield* team.updateMemberStatus({
          sessionId: charlie.session.sessionId,
          payload: { memberId: bob.member.id, status: "suspended" },
        });
        expect(bobSuspended.status).toBe("suspended");
        const bobVerifyAfterSuspend = yield* Effect.exit(sessions.verify(bob.token));
        expect(bobVerifyAfterSuspend._tag).toBe("Failure");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces server-side Views CRUD, read/post policies, thread locking, and live revocation",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-views" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Views Team", ownerPseudo: "alice" },
        });

        const inviteAndJoin = (pseudo: string, role: "admin" | "modo" | "regular") =>
          Effect.gen(function* () {
            const created = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role, prefilledPseudo: pseudo },
            });
            const redeemed = yield* team.redeemInvite({
              token: created.token,
              pseudo,
              client: testClient,
            });
            const verified = yield* sessions.verify(redeemed.accessToken);
            return { member: redeemed.member, session: verified };
          });

        const dana = yield* inviteAndJoin("dana", "admin");
        const charlie = yield* inviteAndJoin("charlie", "modo");
        const bob = yield* inviteAndJoin("bob", "regular");

        const initialState = yield* team.getState(aliceSession.sessionId);
        expect(initialState.views).toHaveLength(1);
        const defaultView = initialState.views[0]!;
        expect(defaultView.isDefault).toBe(true);
        expect(defaultView.readRule.roles).toEqual([...ALL_TEAM_ROLES]);

        // Default view cannot be deleted, and non-admins cannot create views.
        const deleteDefaultExit = yield* Effect.exit(
          team.deleteView({
            sessionId: aliceSession.sessionId,
            payload: { viewId: defaultView.id },
          }),
        );
        expect(deleteDefaultExit._tag).toBe("Failure");
        if (deleteDefaultExit._tag === "Failure") {
          expect(Cause.squash(deleteDefaultExit.cause)).toMatchObject({
            code: "default_view_protected",
          });
        }
        const charlieCreateViewExit = yield* Effect.exit(
          team.createView({
            sessionId: charlie.session.sessionId,
            payload: {
              name: "Unauthorized",
              readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
              postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            },
          }),
        );
        expect(charlieCreateViewExit._tag).toBe("Failure");

        // Owner creates Staff Only, Announcements, and Admin Only views.
        const staffOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Staff Only",
            description: "Visible to modo+ only",
            readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const announcements = yield* team.createView({
          sessionId: dana.session.sessionId,
          payload: {
            name: "Announcements",
            readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const adminOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Admin Only",
            readRule: { roles: ["owner", "admin"], memberIds: [] },
            postRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });

        // Duplicate view name (case-insensitive) fails with view_name_taken.
        const dupViewExit = yield* Effect.exit(
          team.createView({
            sessionId: aliceSession.sessionId,
            payload: {
              name: "staff only",
              readRule: { roles: ["owner"], memberIds: [] },
              postRule: { roles: ["owner"], memberIds: [] },
            },
          }),
        );
        expect(dupViewExit._tag).toBe("Failure");
        if (dupViewExit._tag === "Failure") {
          expect(Cause.squash(dupViewExit.cause)).toMatchObject({ code: "view_name_taken" });
        }

        // Bob's state lists only views Bob can read (Default + Announcements, NOT Staff Only / Admin Only).
        const bobState = yield* team.getState(bob.session.sessionId);
        expect(bobState.views.map((view) => view.name).toSorted()).toEqual([
          "Announcements",
          "Default",
        ]);

        // Alice creates a thread in Default View; Bob follows it and can read & post initially.
        const aliceThreadId = ThreadId.make("thread-alice-default");
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceThreadId,
        });
        yield* team.followThread({
          sessionId: bob.session.sessionId,
          payload: { threadId: aliceThreadId },
        });
        expect(yield* team.canReadThread(bob.session.sessionId, aliceThreadId)).toBe(true);
        expect(yield* team.canPostInThread(bob.session.sessionId, aliceThreadId)).toBe(true);

        // Subscribe Bob to live team state and access changes, then Charlie (modo) moves thread to Staff Only.
        const bobStreamFiber = yield* team
          .streamState(bob.session.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        const accessChangeFiber = yield* team
          .subscribeAccessChanges()
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;

        // Charlie cannot move thread to Admin Only (inaccessible to Charlie), nor can Bob move any thread.
        const charlieToAdminExit = yield* Effect.exit(
          team.setThreadView({
            sessionId: charlie.session.sessionId,
            payload: { threadId: aliceThreadId, viewId: adminOnly.id },
          }),
        );
        expect(charlieToAdminExit._tag).toBe("Failure");
        const bobMoveExit = yield* Effect.exit(
          team.setThreadView({
            sessionId: bob.session.sessionId,
            payload: { threadId: aliceThreadId, viewId: announcements.id },
          }),
        );
        expect(bobMoveExit._tag).toBe("Failure");

        const moved = yield* team.setThreadView({
          sessionId: charlie.session.sessionId,
          payload: { threadId: aliceThreadId, viewId: staffOnly.id },
        });
        expect(moved.viewId).toBe(staffOnly.id);

        // Bob immediately loses read/post access, receives threadRemoved, and is removed from notification recipients.
        expect(yield* team.canReadThread(bob.session.sessionId, aliceThreadId)).toBe(false);
        expect(yield* team.canPostInThread(bob.session.sessionId, aliceThreadId)).toBe(false);
        expect(
          yield* team.shouldNotifyMemberForThread({
            memberId: bob.member.id,
            threadId: aliceThreadId,
          }),
        ).toBe(false);
        const bobEvents = yield* Fiber.join(bobStreamFiber);
        expect(bobEvents[1]).toMatchObject({
          type: "threadRemoved",
          payload: { threadId: aliceThreadId },
        });
        expect((yield* Fiber.join(accessChangeFiber)).length).toBe(1);

        // Move Alice's thread to Announcements -> Bob can read it again, CANNOT post in it.
        yield* team.setThreadView({
          sessionId: aliceSession.sessionId,
          payload: { threadId: aliceThreadId, viewId: announcements.id },
        });
        expect(yield* team.canReadThread(bob.session.sessionId, aliceThreadId)).toBe(true);
        expect(yield* team.canPostInThread(bob.session.sessionId, aliceThreadId)).toBe(false);
        const bobDispatchInAliceExit = yield* Effect.exit(
          team.assertCanDispatchCommand(bob.session.sessionId, {
            type: "message.dispatch",
            commandId: CommandId.make("cmd-bob-blocked"),
            threadId: aliceThreadId,
            messageId: MessageId.make("msg-bob-blocked"),
            createdBy: "user",
            creationSource: "web",
            text: "Trying to post",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          }),
        );
        expect(bobDispatchInAliceExit._tag).toBe("Failure");
        if (bobDispatchInAliceExit._tag === "Failure") {
          expect(Cause.squash(bobDispatchInAliceExit.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
        }

        // Bob CAN create his own thread in Announcements and post in it, until Alice locks it.
        yield* team.assertCanLaunchThread({
          sessionId: bob.session.sessionId,
          viewId: announcements.id,
          locked: false,
        });
        const bobCannotLaunchLockedExit = yield* Effect.exit(
          team.assertCanLaunchThread({
            sessionId: bob.session.sessionId,
            viewId: announcements.id,
            locked: true,
          }),
        );
        expect(bobCannotLaunchLockedExit._tag).toBe("Failure");

        const bobThreadId = ThreadId.make("thread-bob-announcements");
        yield* team.prepareThreadAttribution({
          sessionId: bob.session.sessionId,
          threadId: bobThreadId,
          viewId: announcements.id,
          locked: false,
        });
        expect(yield* team.canPostInThread(bob.session.sessionId, bobThreadId)).toBe(true);

        // Charlie (modo) cannot lock threads; Alice (owner) locks Bob's own thread -> blocks Bob AND Charlie, allows Alice & Dana.
        const charlieLockExit = yield* Effect.exit(
          team.setThreadLocked({
            sessionId: charlie.session.sessionId,
            payload: { threadId: bobThreadId, locked: true },
          }),
        );
        expect(charlieLockExit._tag).toBe("Failure");

        const lockedAttr = yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId: bobThreadId, locked: true },
        });
        expect(lockedAttr.locked).toBe(true);
        expect(lockedAttr.lockedByMemberId).toBe(init.owner.id);
        expect(yield* team.canPostInThread(bob.session.sessionId, bobThreadId)).toBe(false);
        expect(yield* team.canPostInThread(charlie.session.sessionId, bobThreadId)).toBe(false);
        expect(yield* team.canPostInThread(aliceSession.sessionId, bobThreadId)).toBe(true);
        expect(yield* team.canPostInThread(dana.session.sessionId, bobThreadId)).toBe(true);

        // Unlocking restores Bob's post permission in his own thread.
        const unlockedAttr = yield* team.setThreadLocked({
          sessionId: dana.session.sessionId,
          payload: { threadId: bobThreadId, locked: false },
        });
        expect(unlockedAttr.locked).toBe(false);
        expect(unlockedAttr.lockedByMemberId).toBeNull();
        expect(yield* team.canPostInThread(bob.session.sessionId, bobThreadId)).toBe(true);

        // Deleting Announcements view reassigns Bob's thread back to Default View.
        const deleted = yield* team.deleteView({
          sessionId: aliceSession.sessionId,
          payload: { viewId: announcements.id },
        });
        expect(deleted).toEqual({ deleted: true, fallbackViewId: defaultView.id });
        const stateAfterDelete = yield* team.getState(aliceSession.sessionId);
        expect(
          stateAfterDelete.threadAttributions.find((attr) => attr.threadId === bobThreadId)?.viewId,
        ).toBe(defaultView.id);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "reconciles session scopes on admin-tier role changes, revokes DPoP keys on suspension, enforces guest-share/workflow/delete/fork guards, validates memberIds, and prevents streamState threadId leaks",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({
          subject: "owner-alice",
          method: "browser-session-cookie",
          scopes: AuthStandardClientScopes,
        });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });

        const adminInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "admin", prefilledPseudo: "dana" },
        });
        const danaRedeemed = yield* team.redeemInvite({
          token: adminInvite.token,
          pseudo: "dana",
          client: { deviceType: "desktop" },
          proofKeyThumbprint: "jkt-dana",
        });
        const danaVerifiedBefore = yield* sessions.verify(danaRedeemed.accessToken);
        expect(danaVerifiedBefore.scopes).toContain(AuthAccessWriteScope);

        const regularInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: regularInvite.token,
          pseudo: "bob",
          client: { deviceType: "desktop" },
          proofKeyThumbprint: "jkt-bob",
        });
        const bobVerifiedBefore = yield* sessions.verify(bobRedeemed.accessToken);
        expect(bobVerifiedBefore.scopes).not.toContain(AuthAccessWriteScope);

        // 1. Demoting Dana (admin -> regular) narrows DB session scopes AND triggers awaitInvalidation.
        const danaInvalidationFiber = yield* Effect.forkChild(
          sessions.awaitInvalidation(danaVerifiedBefore.sessionId, "jkt-dana"),
        );
        yield* Effect.yieldNow;
        yield* team.updateMemberRole({
          sessionId: aliceSession.sessionId,
          payload: { memberId: danaRedeemed.member.id, role: "regular" },
        });
        yield* Fiber.join(danaInvalidationFiber);
        const danaVerifiedAfterDemote = yield* sessions.verify(danaRedeemed.accessToken);
        expect(danaVerifiedAfterDemote.scopes).not.toContain(AuthAccessWriteScope);

        // 1b. Bootstrap race: demotion landing BEFORE awaitInvalidation starts still invalidates immediately when expectedScopes are passed.
        yield* sessions.awaitInvalidation(
          danaVerifiedBefore.sessionId,
          "jkt-dana",
          danaVerifiedBefore.scopes,
        );

        // 2. Promoting Bob (regular -> admin) broadens DB session scopes AND triggers awaitInvalidation.
        const bobInvalidationFiber = yield* Effect.forkChild(
          sessions.awaitInvalidation(bobVerifiedBefore.sessionId, "jkt-bob"),
        );
        yield* Effect.yieldNow;
        yield* team.updateMemberRole({
          sessionId: aliceSession.sessionId,
          payload: { memberId: bobRedeemed.member.id, role: "admin" },
        });
        yield* Fiber.join(bobInvalidationFiber);
        const bobVerifiedAfterPromote = yield* sessions.verify(bobRedeemed.accessToken);
        expect(bobVerifiedAfterPromote.scopes).toContain(AuthAccessWriteScope);

        // Demote Bob back to regular for RBAC checks below.
        yield* team.updateMemberRole({
          sessionId: aliceSession.sessionId,
          payload: { memberId: bobRedeemed.member.id, role: "regular" },
        });

        // 3. View memberIds validation rejects unknown member IDs.
        const invalidMemberExit = yield* Effect.exit(
          team.createView({
            sessionId: aliceSession.sessionId,
            payload: {
              name: "Bad View",
              readRule: {
                roles: ["owner"],
                memberIds: [TeamMemberId.make("member-does-not-exist")],
              },
              postRule: { roles: ["owner"], memberIds: [] },
            },
          }),
        );
        expect(invalidMemberExit._tag).toBe("Failure");

        // 4. Create Staff Only view & test streamState non-leakage of unseen restricted threadIds.
        const staffOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Staff Only",
            readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const bobStateEvents: Array<TeamStateStreamEvent> = [];
        const bobStateFiber = yield* Effect.forkChild(
          team.streamState(bobVerifiedBefore.sessionId).pipe(
            Stream.take(2),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                bobStateEvents.push(event);
              }),
            ),
          ),
        );
        yield* Effect.yieldNow;

        // Brand-new Staff Only thread must NOT leak a threadRemoved event to Bob.
        const unseenSecretThreadId = ThreadId.make("thread-unseen-secret");
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: unseenSecretThreadId,
          viewId: staffOnly.id,
        });
        // A Default-view thread Bob CAN read arrives as event #2 (proving the unseen secret was skipped).
        const visibleDefaultThreadId = ThreadId.make("thread-visible-default");
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: visibleDefaultThreadId,
        });
        yield* Fiber.join(bobStateFiber);
        expect(bobStateEvents).toHaveLength(2);
        expect(bobStateEvents[0]?.type).toBe("snapshot");
        expect(bobStateEvents[1]?.type).toBe("threadAttributed");
        if (bobStateEvents[1]?.type === "threadAttributed") {
          expect(bobStateEvents[1].payload.threadId).toBe(visibleDefaultThreadId);
        }

        // 5. Guest share, workflow, and scheduled-task guards.
        expect(
          (yield* Effect.exit(
            team.assertCanCreateGuestShare(bobVerifiedBefore.sessionId, unseenSecretThreadId),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertCanCreateGuestShare(aliceSession.sessionId, unseenSecretThreadId);
        expect(
          (yield* Effect.exit(team.assertCanUseWorkflows(bobVerifiedBefore.sessionId)))._tag,
        ).toBe("Failure");
        yield* team.assertCanUseWorkflows(aliceSession.sessionId);
        expect(
          (yield* Effect.exit(team.assertCanUseScheduledTasks(bobVerifiedBefore.sessionId)))._tag,
        ).toBe("Failure");
        yield* team.assertCanUseScheduledTasks(aliceSession.sessionId);

        // 6. thread.delete restriction: colleague cannot delete Alice's thread even in Default View.
        const bobDeleteAliceExit = yield* Effect.exit(
          team.assertCanDispatchCommand(bobVerifiedBefore.sessionId, {
            type: "thread.delete",
            commandId: CommandId.make("cmd-del-1"),
            threadId: visibleDefaultThreadId,
          }),
        );
        expect(bobDeleteAliceExit._tag).toBe("Failure");
        yield* team.assertCanDispatchCommand(aliceSession.sessionId, {
          type: "thread.delete",
          commandId: CommandId.make("cmd-del-2"),
          threadId: visibleDefaultThreadId,
        });

        // 7. thread.fork inherits restricted viewId via prepareThreadInheritedFromParent.
        const forkedSecretId = ThreadId.make("thread-forked-secret");
        const preparedFork = yield* team.prepareThreadInheritedFromParent({
          parentThreadId: unseenSecretThreadId,
          threadId: forkedSecretId,
          creatorSessionId: aliceSession.sessionId,
        });
        expect(preparedFork).toBe(true);
        expect(yield* team.canReadThread(bobVerifiedBefore.sessionId, forkedSecretId)).toBe(false);
        expect(yield* team.canReadThread(aliceSession.sessionId, forkedSecretId)).toBe(true);

        // 8. Post-team unattributed threads fail closed for regular members (owner retains access).
        const unattributedPostTeamId = ThreadId.make("thread-post-team-no-meta");
        expect(yield* team.canReadThread(bobVerifiedBefore.sessionId, unattributedPostTeamId)).toBe(
          false,
        );
        expect(yield* team.canReadThread(aliceSession.sessionId, unattributedPostTeamId)).toBe(
          true,
        );
        const filteredIds = yield* team.filterReadableThreadIds(bobVerifiedBefore.sessionId, [
          unattributedPostTeamId,
          visibleDefaultThreadId,
        ]);
        expect(filteredIds.has(unattributedPostTeamId)).toBe(false);
        expect(filteredIds.has(visibleDefaultThreadId)).toBe(true);

        // 8b. MCP child of a pre-team legacy parent thread gets Default View attribution so regular members can read it.
        const sql = yield* SqlClient.SqlClient;
        const legacyParentId = ThreadId.make("thread-legacy-parent-for-mcp");
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode,
            interaction_mode, active_provider_thread_id, created_at, updated_at,
            archived_at, deleted_at, payload_json
          ) VALUES (
            ${legacyParentId}, 'proj-legacy', 'Legacy parent', 'codex', 'full-access',
            'default', NULL, '1969-12-31T23:59:59.000Z', '1969-12-31T23:59:59.000Z',
            NULL, NULL, '{}'
          )
        `;
        const legacyMcpChildId = ThreadId.make("thread-legacy-mcp-child");
        const preparedLegacyChild = yield* team.prepareThreadInheritedFromParent({
          parentThreadId: legacyParentId,
          threadId: legacyMcpChildId,
        });
        expect(preparedLegacyChild).toBe(true);
        expect(yield* team.canReadThread(bobVerifiedBefore.sessionId, legacyMcpChildId)).toBe(true);

        // 9. Suspending Dana revokes her session (and DPoP key) immediately.
        yield* team.updateMemberStatus({
          sessionId: aliceSession.sessionId,
          payload: { memberId: danaRedeemed.member.id, status: "suspended" },
        });
        const danaVerifyAfterSuspend = yield* Effect.exit(
          sessions.verify(danaRedeemed.accessToken),
        );
        expect(danaVerifyAfterSuspend._tag).toBe("Failure");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces Milestone 4 non-creator mid-turn queueing, creator-only Send now, owner/admin Interrupt + hook, and member-attributed child inheritance",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessions.issue({ subject: "owner-m4" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "M4 Team", ownerPseudo: "alice" },
        });
        const inviteMember = (role: "admin" | "modo" | "regular", pseudo: string) =>
          Effect.gen(function* () {
            const invite = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role, prefilledPseudo: pseudo },
            });
            const redeemed = yield* team.redeemInvite({
              token: invite.token,
              pseudo,
              client: testClient,
            });
            const verified = yield* sessions.verify(redeemed.accessToken);
            return { member: redeemed.member, sessionId: verified.sessionId };
          });

        const dana = yield* inviteMember("admin", "dana");
        const charlie = yield* inviteMember("modo", "charlie");
        const bob = yield* inviteMember("regular", "bob");

        // Create Bob's thread with an active run authored by Bob in the projection table.
        const bobThreadId = ThreadId.make("thread-m4-bob");
        const bobActiveRunId = RunId.make("run-m4-bob-active");
        const bobQueuedRunId = RunId.make("run-m4-bob-queued");
        const charlieQueuedRunId = RunId.make("run-m4-charlie-queued");
        yield* team.recordThreadCreated({ sessionId: bob.sessionId, threadId: bobThreadId });
        yield* team.recordTurnAuthored({
          sessionId: bob.sessionId,
          threadId: bobThreadId,
          turnId: bobActiveRunId,
        });
        yield* team.recordTurnAuthored({
          sessionId: bob.sessionId,
          threadId: bobThreadId,
          turnId: bobQueuedRunId,
        });
        yield* team.recordTurnAuthored({
          sessionId: charlie.sessionId,
          threadId: bobThreadId,
          turnId: charlieQueuedRunId,
        });

        const activeRunPayload = JSON.stringify({
          id: bobActiveRunId,
          threadId: bobThreadId,
          status: "running",
          userMessageId: "msg-bob-active",
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            ${bobActiveRunId}, ${bobThreadId}, 1, 'codex', NULL,
            'running', '2026-01-01T00:00:01.000Z', NULL, ${activeRunPayload}
          )
        `;

        const makeSendCmd = (
          id: string,
          dispatchModeType:
            | "start_immediately"
            | "queue_after_active"
            | "steer_active"
            | "restart_active",
        ) =>
          ({
            type: "message.dispatch" as const,
            commandId: CommandId.make(`cmd-${id}`),
            threadId: bobThreadId,
            messageId: MessageId.make(`msg-${id}`),
            text: `hello ${id}`,
            attachments: [],
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            dispatchMode:
              dispatchModeType === "steer_active" || dispatchModeType === "restart_active"
                ? { type: dispatchModeType, targetRunId: bobActiveRunId }
                : { type: dispatchModeType },
          }) as unknown as Parameters<
            TeamService.TeamService["Service"]["assertAndNormalizeDispatchCommand"]
          >[1];

        // 1. Non-creator (even owner Alice!) sending start_immediately or deliveryIntent: "auto"
        //    is normalized to queue_after_active with deliveryIntent stripped — NEVER auto-steers!
        const normalizedAliceSend = yield* team.assertAndNormalizeDispatchCommand(
          aliceSession.sessionId,
          {
            ...makeSendCmd("alice-midturn", "start_immediately"),
            deliveryIntent: "auto",
          } as Parameters<
            TeamService.TeamService["Service"]["assertAndNormalizeDispatchCommand"]
          >[1],
        );
        expect(normalizedAliceSend.type).toBe("message.dispatch");
        if (normalizedAliceSend.type === "message.dispatch") {
          expect(normalizedAliceSend.dispatchMode.type).toBe("queue_after_active");
          expect(normalizedAliceSend.deliveryIntent).toBeUndefined();
        }

        // Bob (creator) sending start_immediately keeps start_immediately.
        const normalizedBobSend = yield* team.assertAndNormalizeDispatchCommand(
          bob.sessionId,
          makeSendCmd("bob-midturn", "start_immediately"),
        );
        if (normalizedBobSend.type === "message.dispatch") {
          expect(normalizedBobSend.dispatchMode.type).toBe("start_immediately");
        }

        // 2. Non-creator steer_active, restart_active, and deliveryIntent steer/restart are rejected even for owner/admin.
        for (const policy of ["steer_active", "restart_active"] as const) {
          for (const actorSession of [aliceSession.sessionId, dana.sessionId, charlie.sessionId]) {
            const exit = yield* Effect.exit(
              team.assertAndNormalizeDispatchCommand(
                actorSession,
                makeSendCmd(`steer-${policy}`, policy),
              ),
            );
            expect(exit._tag).toBe("Failure");
          }
        }
        for (const intent of ["steer", "restart"] as const) {
          for (const actorSession of [aliceSession.sessionId, dana.sessionId, charlie.sessionId]) {
            const exit = yield* Effect.exit(
              team.assertAndNormalizeDispatchCommand(actorSession, {
                ...makeSendCmd(`intent-${intent}`, "queue_after_active"),
                deliveryIntent: intent,
              } as Parameters<
                TeamService.TeamService["Service"]["assertAndNormalizeDispatchCommand"]
              >[1]),
            );
            expect(exit._tag).toBe("Failure");
          }
        }

        // 3. Send now (queued-message.promote-to-steer) is STRICTLY creator-only (rejected for owner/admin/modo).
        const promoteCmd = {
          type: "queued-message.promote-to-steer" as const,
          commandId: CommandId.make("cmd-promote"),
          threadId: bobThreadId,
          queuedRunId: charlieQueuedRunId,
          targetRunId: bobActiveRunId,
        };
        for (const actorSession of [aliceSession.sessionId, dana.sessionId, charlie.sessionId]) {
          const exit = yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(actorSession, promoteCmd),
          );
          expect(exit._tag).toBe("Failure");
          const startQueuedExit = yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(actorSession, {
              type: "queued-run.start",
              commandId: CommandId.make("cmd-start-queued"),
              threadId: bobThreadId,
              runId: charlieQueuedRunId,
            }),
          );
          expect(startQueuedExit._tag).toBe("Failure");
        }
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, promoteCmd);
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, {
          type: "queued-run.start",
          commandId: CommandId.make("cmd-start-queued-bob"),
          threadId: bobThreadId,
          runId: charlieQueuedRunId,
        });

        // 4. Interrupt matrix:
        //    - Alice (owner), Dana (admin), Bob (creator), and Charlie (modo on unlocked thread) allowed.
        //    - Regular non-creator (Eve) rejected even on unlocked thread.
        //    - On a LOCKED thread, Charlie (modo) is rejected while Alice (owner) & Dana (admin) remain allowed.
        const eve = yield* inviteMember("regular", "eve");
        const interruptCmd = {
          type: "run.interrupt" as const,
          commandId: CommandId.make("cmd-interrupt"),
          threadId: bobThreadId,
          runId: bobActiveRunId,
        };
        const eveInterruptExit = yield* Effect.exit(
          team.assertAndNormalizeDispatchCommand(eve.sessionId, interruptCmd),
        );
        expect(eveInterruptExit._tag).toBe("Failure");
        yield* team.assertAndNormalizeDispatchCommand(charlie.sessionId, interruptCmd);
        yield* team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, interruptCmd);
        yield* team.assertAndNormalizeDispatchCommand(dana.sessionId, interruptCmd);
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, interruptCmd);

        // Locking the thread blocks modo (Charlie) from interrupting Bob's active turn, while owner/admin remain allowed.
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId: bobThreadId, locked: true },
        });
        expect(
          (yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(charlie.sessionId, interruptCmd),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, interruptCmd);
        yield* team.assertAndNormalizeDispatchCommand(dana.sessionId, interruptCmd);
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId: bobThreadId, locked: false },
        });

        // 4a. Past completed run authored by a regular non-creator cannot grant interrupt rights; subagent.stop follows interrupt matrix.
        const evePastRunId = RunId.make("run-m4-eve-completed");
        yield* team.recordTurnAuthored({
          sessionId: eve.sessionId,
          threadId: bobThreadId,
          turnId: evePastRunId,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            ${evePastRunId},
            ${bobThreadId},
            99,
            'codex',
            NULL,
            'completed',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:02.000Z',
            ${JSON.stringify({ id: evePastRunId, threadId: bobThreadId, status: "completed", userMessageId: "msg-eve-past" })}
          )
        `;
        expect(
          (yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(eve.sessionId, {
              type: "run.interrupt",
              commandId: CommandId.make("cmd-interrupt-past"),
              threadId: bobThreadId,
              runId: evePastRunId,
            }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(eve.sessionId, {
              type: "subagent.stop",
              commandId: CommandId.make("cmd-subagent-stop-eve"),
              threadId: bobThreadId,
              runId: bobActiveRunId,
              subagentId: NodeId.make("node-sub-1"),
            }),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertAndNormalizeDispatchCommand(charlie.sessionId, {
          type: "subagent.stop",
          commandId: CommandId.make("cmd-subagent-stop-charlie"),
          threadId: bobThreadId,
          runId: bobActiveRunId,
          subagentId: NodeId.make("node-sub-1"),
        });
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, {
          type: "subagent.stop",
          commandId: CommandId.make("cmd-subagent-stop-bob"),
          threadId: bobThreadId,
          runId: bobActiveRunId,
          subagentId: NodeId.make("node-sub-1"),
        });

        // 4b. Pending tool-approval / user-input responses stay restricted to owner/admin, creator, or active turn author (never modo on foreign turns!).
        const respondCmd = {
          type: "runtime-request.respond" as const,
          commandId: CommandId.make("cmd-respond"),
          threadId: bobThreadId,
          requestId: RuntimeRequestId.make("req-approval-1"),
          decision: "decline" as const,
        };
        const dismissCmd = {
          type: "thread.user-input.dismiss" as const,
          commandId: CommandId.make("cmd-dismiss"),
          threadId: bobThreadId,
          requestId: RuntimeRequestId.make("req-approval-1"),
        };
        expect(
          (yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(charlie.sessionId, respondCmd),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertAndNormalizeDispatchCommand(charlie.sessionId, dismissCmd),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, respondCmd);
        yield* team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, respondCmd);
        yield* team.assertAndNormalizeDispatchCommand(bob.sessionId, dismissCmd);

        // 4c. Queued-message notification emits to thread creator AND distinct active turn author (never sender or unrelated colleague),
        //     filters per session stream, and is idempotent per queuedRunId and commandId.
        const bobEvents: Array<TeamStateStreamEvent> = [];
        const eveEvents: Array<TeamStateStreamEvent> = [];
        const charlieEvents: Array<TeamStateStreamEvent> = [];
        const triggerEvents: Array<TeamService.TeamNotificationTriggerEvent> = [];
        const bobFiber = yield* team.streamState(bob.sessionId).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              bobEvents.push(event);
            }),
          ),
          Effect.forkChild,
        );
        const eveFiber = yield* team.streamState(eve.sessionId).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              eveEvents.push(event);
            }),
          ),
          Effect.forkChild,
        );
        const charlieFiber = yield* team.streamState(charlie.sessionId).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              charlieEvents.push(event);
            }),
          ),
          Effect.forkChild,
        );
        const triggerFiber = yield* team.subscribeNotificationEvents!().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              triggerEvents.push(event);
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        // Make Eve the active turn author on Bob's thread so Charlie queuing notifies BOTH Bob (creator) AND Eve (active turn author).
        const eveActiveRunId = RunId.make("run-m4-eve-active");
        yield* team.recordTurnAuthored({
          sessionId: eve.sessionId,
          threadId: bobThreadId,
          turnId: eveActiveRunId,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            ${eveActiveRunId},
            ${bobThreadId},
            100,
            'codex',
            NULL,
            'running',
            '2026-01-01T00:01:00.000Z',
            NULL,
            ${JSON.stringify({ id: eveActiveRunId, threadId: bobThreadId, status: "running", userMessageId: "msg-eve-active" })}
          )
        `;
        const queuedNotifyRes = yield* team.notifyQueuedMessage({
          actor: { kind: "session", sessionId: charlie.sessionId },
          threadId: bobThreadId,
          queuedRunId: "run-m4-charlie-queued-notif",
          commandId: "cmd-m4-charlie-queued-notif",
          messageText: "  Please check the CI failure  ",
        });
        expect(queuedNotifyRes.notifiedMemberIds).toEqual([bob.member.id, eve.member.id]);

        // Duplicate call with same queuedRunId OR same commandId is a no-op (idempotent).
        expect(
          (yield* team.notifyQueuedMessage({
            actor: { kind: "session", sessionId: charlie.sessionId },
            threadId: bobThreadId,
            queuedRunId: "run-m4-charlie-queued-notif",
            commandId: "cmd-m4-different",
            messageText: "duplicate run",
          })).notifiedMemberIds,
        ).toEqual([]);
        expect(
          (yield* team.notifyQueuedMessage({
            actor: { kind: "session", sessionId: charlie.sessionId },
            threadId: bobThreadId,
            queuedRunId: "run-m4-different",
            commandId: "cmd-m4-charlie-queued-notif",
            messageText: "duplicate cmd",
          })).notifiedMemberIds,
        ).toEqual([]);

        // Verify Bob and Eve receive the stream event; sender Charlie does NOT; relay trigger emitted once.
        for (let i = 0; i < 5; i += 1) {
          yield* Effect.yieldNow;
        }
        expect(bobEvents.filter((e) => e.type === "queuedMessageNotification")).toHaveLength(1);
        expect(eveEvents.filter((e) => e.type === "queuedMessageNotification")).toHaveLength(1);
        expect(charlieEvents.filter((e) => e.type === "queuedMessageNotification")).toHaveLength(0);
        expect(triggerEvents.filter((e) => e.type === "queuedMessage")).toHaveLength(1);

        // When Bob (creator) queues while Eve's turn is running, ONLY Eve is notified (never sender Bob!).
        const bobQueueRes = yield* team.notifyQueuedMessage({
          actor: { kind: "session", sessionId: bob.sessionId },
          threadId: bobThreadId,
          queuedRunId: "run-m4-bob-queued-while-eve",
          messageText: "Heads up Eve",
        });
        expect(bobQueueRes.notifiedMemberIds).toEqual([eve.member.id]);

        // Concurrent duplicate notifications for the same queuedRunId emit only once (no TOCTOU race).
        const [raceA, raceB] = yield* Effect.all(
          [
            team.notifyQueuedMessage({
              actor: { kind: "session", sessionId: charlie.sessionId },
              threadId: bobThreadId,
              queuedRunId: "run-m4-concurrent-dedup",
              commandId: "cmd-m4-concurrent-dedup",
              activeRunId: eveActiveRunId,
              messageText: "Concurrent test",
            }),
            team.notifyQueuedMessage({
              actor: { kind: "session", sessionId: charlie.sessionId },
              threadId: bobThreadId,
              queuedRunId: "run-m4-concurrent-dedup",
              commandId: "cmd-m4-concurrent-dedup",
              activeRunId: eveActiveRunId,
              messageText: "Concurrent test",
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect([raceA.notifiedMemberIds.length, raceB.notifiedMemberIds.length].toSorted()).toEqual(
          [0, 2],
        );

        // If Eve's active run completes and Charlie's queued run advances to running before notification
        // processing, supplying the captured activeRunId still resolves Eve (not Charlie).
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = 'completed'
          WHERE run_id = ${eveActiveRunId}
        `;
        const charliePromotedRunId = "run-m4-charlie-promoted";
        yield* team.recordTurnAuthored({
          sessionId: charlie.sessionId,
          threadId: bobThreadId,
          turnId: charliePromotedRunId,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            ${charliePromotedRunId},
            ${bobThreadId},
            101,
            'codex',
            NULL,
            'running',
            '2026-01-01T00:02:00.000Z',
            NULL,
            ${JSON.stringify({ id: charliePromotedRunId, threadId: bobThreadId, status: "running", userMessageId: "msg-charlie-promoted" })}
          )
        `;
        const capturedActiveRunRes = yield* team.notifyQueuedMessage({
          actor: { kind: "session", sessionId: charlie.sessionId },
          threadId: bobThreadId,
          queuedRunId: charliePromotedRunId,
          activeRunId: eveActiveRunId,
          messageText: "Queued before Eve finished",
        });
        expect(capturedActiveRunRes.notifiedMemberIds).toEqual([bob.member.id, eve.member.id]);

        // Idle thread (no active run in projection and no captured activeRunId) notifies nobody.
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = 'completed'
          WHERE thread_id = ${bobThreadId}
        `;
        const idleQueueRes = yield* team.notifyQueuedMessage({
          actor: { kind: "session", sessionId: charlie.sessionId },
          threadId: bobThreadId,
          queuedRunId: "run-m4-idle-thread",
          messageText: "Should not notify on idle thread",
        });
        expect(idleQueueRes.notifiedMemberIds).toEqual([]);

        // Suspended candidate recipient is excluded even when named as active turn author.
        yield* team.updateMemberStatus({
          sessionId: aliceSession.sessionId,
          payload: { memberId: eve.member.id, status: "suspended" },
        });
        const suspendedActiveRes = yield* team.notifyQueuedMessage({
          actor: { kind: "session", sessionId: charlie.sessionId },
          threadId: bobThreadId,
          queuedRunId: "run-m4-eve-suspended",
          activeRunId: eveActiveRunId,
          messageText: "Eve suspended",
        });
        expect(suspendedActiveRes.notifiedMemberIds).toEqual([bob.member.id]);
        yield* team.updateMemberStatus({
          sessionId: aliceSession.sessionId,
          payload: { memberId: eve.member.id, status: "active" },
        });

        yield* Fiber.interrupt(bobFiber);
        yield* Fiber.interrupt(eveFiber);
        yield* Fiber.interrupt(charlieFiber);
        yield* Fiber.interrupt(triggerFiber);

        // 5. Queued run management (cancel/edit): Charlie can cancel his own queued message, not Bob's; Alice can cancel any.
        yield* team.assertAndNormalizeDispatchCommand(charlie.sessionId, {
          type: "queued-run.cancel",
          commandId: CommandId.make("cmd-cancel-own"),
          threadId: bobThreadId,
          runId: charlieQueuedRunId,
        });
        const charlieCancelBobExit = yield* Effect.exit(
          team.assertAndNormalizeDispatchCommand(charlie.sessionId, {
            type: "queued-run.cancel",
            commandId: CommandId.make("cmd-cancel-other"),
            threadId: bobThreadId,
            runId: bobQueuedRunId,
          }),
        );
        expect(charlieCancelBobExit._tag).toBe("Failure");
        yield* team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, {
          type: "queued-run.cancel",
          commandId: CommandId.make("cmd-cancel-admin"),
          threadId: bobThreadId,
          runId: bobQueuedRunId,
        });

        // 6. Milestone 7 interrupt hook receives structured interrupt metadata and unsubscribes cleanly.
        const hookEvents: Array<TeamService.TeamTurnInterruptEvent> = [];
        const unsubscribe = yield* team.registerTurnInterruptHook((event) =>
          Effect.sync(() => {
            hookEvents.push(event);
          }),
        );
        yield* team.notifyTurnInterrupted({
          actor: { kind: "session", sessionId: aliceSession.sessionId },
          threadId: bobThreadId,
          runId: bobActiveRunId,
          reason: "interrupt",
        });
        expect(hookEvents).toEqual([
          {
            threadId: bobThreadId,
            runId: bobActiveRunId,
            actorMemberId: init.owner.id,
            activeTurnAuthorMemberId: bob.member.id,
            reason: "interrupt",
          },
        ]);
        unsubscribe();
        yield* team.notifyTurnInterrupted({
          actor: { kind: "session", sessionId: aliceSession.sessionId },
          threadId: bobThreadId,
          runId: bobActiveRunId,
          reason: "interrupt",
        });
        expect(hookEvents).toHaveLength(1);

        // 7. Pre-recorded message attribution resolves turn author before runId exists,
        //    continuation turns inherit continuedFromRunId author, and unattributed runs fail closed (never escalate to creator).
        yield* team.prepareTurnAttributionForCommand(
          charlie.sessionId,
          makeSendCmd("charlie-pre", "queue_after_active"),
        );
        const resolvedAuthor = yield* team.resolveTurnAuthorMemberId({
          threadId: bobThreadId,
          userMessageId: MessageId.make("msg-charlie-pre"),
        });
        expect(Option.getOrThrow(resolvedAuthor)).toBe(charlie.member.id);
        const resolvedContinuation = yield* team.resolveTurnAuthorMemberId({
          threadId: bobThreadId,
          runId: "run-unrecorded-continuation",
          continuedFromRunId: evePastRunId,
        });
        expect(Option.getOrThrow(resolvedContinuation)).toBe(eve.member.id);
        const unattributedAuthor = yield* team.resolveTurnAuthorMemberId({
          threadId: bobThreadId,
          runId: "run-missing-attribution",
          userMessageId: "msg-missing-attribution",
        });
        expect(Option.isNone(unattributedAuthor)).toBe(true);

        // 8. Child thread inheritance with explicit creatorMemberId preserves parent's restricted View
        //    while attributing child creator & initial turn to actingMemberId (never widening).
        const staffOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Staff Only M4",
            readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const aliceStaffThreadId = ThreadId.make("thread-m4-staff-parent");
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceStaffThreadId,
          viewId: staffOnly.id,
        });
        const charlieChildThreadId = ThreadId.make("thread-m4-staff-child");
        yield* team.prepareThreadInheritedFromParent({
          parentThreadId: aliceStaffThreadId,
          threadId: charlieChildThreadId,
          creatorMemberId: charlie.member.id,
        });
        const childAttr = Option.getOrThrow(yield* repo.getThreadAttribution(charlieChildThreadId));
        expect(childAttr.viewId).toBe(staffOnly.id);
        expect(childAttr.creatorMemberId).toBe(charlie.member.id);
        expect(yield* team.canReadThread(bob.sessionId, charlieChildThreadId)).toBe(false);
        expect(yield* team.canReadThread(charlie.sessionId, charlieChildThreadId)).toBe(true);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces Milestone 5 team projects, per-environment ACLs, absolute local-execution boundary, immutable hash-pinned thread notes, empty prompts, and TOCTOU concurrent note re-anchoring",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-m5" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "M5 Team", ownerPseudo: "alice" },
        });
        const inviteAndJoin = (pseudo: string, role: "admin" | "modo" | "regular") =>
          Effect.gen(function* () {
            const created = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role, prefilledPseudo: pseudo },
            });
            const redeemed = yield* team.redeemInvite({
              token: created.token,
              pseudo,
              client: testClient,
            });
            const verified = yield* sessions.verify(redeemed.accessToken);
            return { member: redeemed.member, sessionId: verified.sessionId };
          });
        const bob = yield* inviteAndJoin("bob", "regular");
        const charlie = yield* inviteAndJoin("charlie", "modo");

        // 1. Team Projects assignment (owner/admin only) + repo identity correlation.
        const projectId = ProjectId.make("proj-m5-core");
        const bobAssignExit = yield* Effect.exit(
          team.assignProject({
            sessionId: bob.sessionId,
            payload: { projectId, defaultViewId: null, repoIdentityKey: "github.com/acme/m5" },
          }),
        );
        expect(bobAssignExit._tag).toBe("Failure");
        const assigned = yield* team.assignProject({
          sessionId: aliceSession.sessionId,
          payload: {
            projectId,
            defaultViewId: init.team.defaultViewId,
            repoIdentityKey: "github.com/acme/m5",
          },
        });
        expect(assigned.projectId).toBe(projectId);
        expect(assigned.repoIdentityKey).toBe("github.com/acme/m5");

        // 2. Team Environments & per-environment ACLs (Entry 0 default protected; restricted env hidden & blocked for regular Bob).
        const aliceState0 = yield* team.getState(aliceSession.sessionId);
        const defaultEnv = (aliceState0.environments ?? []).find((env) => env.isDefault);
        expect(defaultEnv).toBeDefined();
        const detachDefaultExit = yield* Effect.exit(
          team.detachEnvironment({
            sessionId: aliceSession.sessionId,
            payload: { environmentId: defaultEnv!.environmentId },
          }),
        );
        expect(detachDefaultExit._tag).toBe("Failure");

        const restrictedEnvId = EnvironmentId.make("env-gpu-m5");
        const attached = yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: restrictedEnvId,
            name: "GPU Runner",
            accessRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        expect(attached.environmentId).toBe(restrictedEnvId);

        // Regular Bob cannot see restrictedEnvId in getState, filterAccessibleEnvironmentIds, or assertCanAccessEnvironment.
        const bobState = yield* team.getState(bob.sessionId);
        expect((bobState.environments ?? []).map((e) => e.environmentId)).not.toContain(
          restrictedEnvId,
        );
        expect(
          (yield* team.filterAccessibleEnvironmentIds(bob.sessionId, [
            defaultEnv!.environmentId,
            restrictedEnvId,
          ])).has(restrictedEnvId),
        ).toBe(false);
        expect(
          (yield* Effect.exit(team.assertCanAccessEnvironment(bob.sessionId, restrictedEnvId)))
            ._tag,
        ).toBe("Failure");
        yield* team.assertCanAccessEnvironment(aliceSession.sessionId, restrictedEnvId);

        // 3. Local-to-Team thread syncing + absolute local-execution boundary (even owner Alice cannot execute on Bob's local thread).
        const bobLocalThreadId = ThreadId.make("thread-bob-local-1");
        const bobLaptopEnvId = EnvironmentId.make("env-bob-laptop");
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
          options: [],
        };
        const syncedResult = yield* team.syncLocalThread({
          sessionId: bob.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            projectId,
            executionEnvironmentId: bobLaptopEnvId,
            executionEnvironmentLabel: "Bob Laptop",
            title: "Local debugging",
            branch: "feat/local",
            modelSelection,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            runs: [],
            messages: [],
          },
        });
        expect(syncedResult.attribution.isLocalSynced).toBe(true);
        expect(syncedResult.attribution.executionEnvironmentId).toBe(bobLaptopEnvId);
        expect(syncedResult.attribution.creatorMemberId).toBe(bob.member.id);

        // Alice (owner) cannot overwrite Bob's local-synced thread nor dispatch/execute on it!
        expect(
          (yield* Effect.exit(
            team.syncLocalThread({
              sessionId: aliceSession.sessionId,
              payload: {
                threadId: bobLocalThreadId,
                projectId,
                executionEnvironmentId: bobLaptopEnvId,
                executionEnvironmentLabel: "Hijack",
                title: "Hijack",
                branch: null,
                modelSelection,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:02.000Z",
                runs: [],
                messages: [],
              },
            }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertCanExecuteOnThreadEnvironment(aliceSession.sessionId, bobLocalThreadId),
          ))._tag,
        ).toBe("Failure");

        // 4. Immutable hash-pinned Thread Notes, author delete only while pending, owner Edit preserving originalBody,
        //    empty prompt dispatch, hash-mismatch rejection, zero implicit injection, and TOCTOU concurrent re-anchoring.
        const aliceNote = yield* team.createThreadNote({
          sessionId: aliceSession.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            body: "Check the null guard in parser.ts",
          },
        });
        expect(aliceNote.status).toBe("pending");
        expect(aliceNote.authorRole).toBe("owner");
        expect(aliceNote.originalContentHash.length).toBeGreaterThan(10);

        const charlieNote = yield* team.createThreadNote({
          sessionId: charlie.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            body: "Temporary note to delete",
          },
        });
        // Non-author (Alice) cannot delete Charlie's note; Charlie can delete while pending.
        expect(
          (yield* Effect.exit(
            team.deleteThreadNote({
              sessionId: aliceSession.sessionId,
              payload: { noteId: charlieNote.id },
            }),
          ))._tag,
        ).toBe("Failure");
        const deletedNote = yield* team.deleteThreadNote({
          sessionId: charlie.sessionId,
          payload: { noteId: charlieNote.id },
        });
        expect(deletedNote.deleted).toBe(true);

        // Owner Bob edits Alice's note -> preserves originalBody, computes new editedContentHash, marks accepted.
        const editedNote = yield* team.editThreadNote({
          sessionId: bob.sessionId,
          payload: {
            noteId: aliceNote.id,
            editedBody: "Check the null guard in parser.ts and add a regression test",
            status: "accepted",
          },
        });
        expect(editedNote.originalBody).toBe("Check the null guard in parser.ts");
        expect(editedNote.editedBody).toBe(
          "Check the null guard in parser.ts and add a regression test",
        );
        expect(editedNote.editedContentHash).not.toBeNull();
        expect(editedNote.editedContentHash).not.toBe(editedNote.originalContentHash);

        // Concurrent note arrives from Charlie right before Bob dispatches!
        const concurrentNote = yield* team.createThreadNote({
          sessionId: charlie.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            body: "Wait, also check edge case Z!",
          },
        });
        expect(concurrentNote.status).toBe("pending");

        // Hash mismatch is rejected (e.g., passing stale originalContentHash after edit).
        const staleHashExit = yield* Effect.exit(
          team.consumeAcceptedNotes({
            sessionId: bob.sessionId,
            payload: {
              threadId: bobLocalThreadId,
              targetTurnId: "msg:turn-2",
              acceptedNotes: [
                { noteId: editedNote.id, contentHash: editedNote.originalContentHash },
              ],
            },
          }),
        );
        expect(staleHashExit._tag).toBe("Failure");

        // Consuming with exact editedContentHash succeeds, builds attributed prompt, consumes ONLY editedNote,
        // and atomically re-anchors concurrentNote AFTER "msg:turn-2" (still pending, never implicitly injected!).
        const consumed = yield* team.consumeAcceptedNotes({
          sessionId: bob.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            targetTurnId: "msg:turn-2",
            acceptedNotes: [
              { noteId: editedNote.id, contentHash: effectiveTeamThreadNoteHash(editedNote) },
            ],
          },
        });
        expect(consumed.consumedNotes.map((n) => n.id)).toEqual([editedNote.id]);
        expect(consumed.reanchoredNoteIds).toEqual([concurrentNote.id]);
        expect(consumed.formattedPromptPrefix).toContain(
          "[Note from alice (edited & approved by bob)]:",
        );
        expect(consumed.formattedPromptPrefix).toContain("add a regression test");
        expect(consumed.formattedPromptPrefix).not.toContain("edge case Z");

        const notesAfterConsume = yield* team.listThreadNotes({
          sessionId: bob.sessionId,
          payload: { threadId: bobLocalThreadId },
        });
        const consumedRecord = notesAfterConsume.find((n) => n.id === editedNote.id);
        const reanchoredRecord = notesAfterConsume.find((n) => n.id === concurrentNote.id);
        expect(consumedRecord?.status).toBe("consumed");
        expect(consumedRecord?.includedInTurnId).toBe("msg:turn-2");
        expect(reanchoredRecord?.status).toBe("pending");
        expect(reanchoredRecord?.anchorTurnId).toBe("msg:turn-2");

        // 5. Remote thread empty prompt ("") dispatch with explicit teamAcceptedNotes succeeds,
        //    reserves atomically (blocking concurrent double-injection), and releases on failure.
        const remoteThreadId = ThreadId.make("thread-alice-remote-m5");
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: remoteThreadId,
        });
        const bobRemoteNote = yield* team.createThreadNote({
          sessionId: bob.sessionId,
          payload: {
            threadId: remoteThreadId,
            body: "Run the smoke tests",
          },
        });
        const acceptedRemoteNote = yield* team.resolveThreadNote({
          sessionId: aliceSession.sessionId,
          payload: {
            noteId: bobRemoteNote.id,
            status: "accepted",
            expectedContentHash: bobRemoteNote.originalContentHash,
          },
        });
        const dispatchCmd = {
          type: "message.dispatch" as const,
          commandId: CommandId.make("cmd-empty-with-note"),
          threadId: remoteThreadId,
          messageId: MessageId.make("msg-empty-with-note"),
          createdBy: "user" as const,
          creationSource: "web" as const,
          text: "",
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          teamAcceptedNotes: [
            {
              noteId: acceptedRemoteNote.id,
              contentHash: effectiveTeamThreadNoteHash(acceptedRemoteNote),
            },
          ],
        };
        const normalized = yield* team.assertAndNormalizeDispatchCommand(
          aliceSession.sessionId,
          dispatchCmd,
        );
        const prepared = yield* team.prepareNotesForDispatchCommand({
          sessionId: aliceSession.sessionId,
          command: normalized,
        });
        expect(prepared.reservationToken).not.toBeNull();
        expect(prepared.command.type).toBe("message.dispatch");
        if (prepared.command.type === "message.dispatch") {
          expect(prepared.command.text).toContain("[Note from bob (approved by alice)]:");
          expect(prepared.command.text).toContain("Run the smoke tests");
        }
        // Concurrent second dispatch carrying the same note is rejected while reserved.
        const doubleDispatchExit = yield* Effect.exit(
          team.prepareNotesForDispatchCommand({
            sessionId: aliceSession.sessionId,
            command: normalized,
          }),
        );
        expect(doubleDispatchExit._tag).toBe("Failure");
        // Releasing the reservation (e.g. on failed dispatch) restores retryability.
        yield* team.releaseNoteReservationByToken(prepared.reservationToken!);
        const retried = yield* team.prepareNotesForDispatchCommand({
          sessionId: aliceSession.sessionId,
          command: normalized,
        });
        expect(retried.reservationToken).not.toBeNull();
        yield* team.releaseNoteReservationByToken(retried.reservationToken!);

        // 6. Local-synced threads block execution-capable metadata continuations and thread.settle too.
        const continuationHijackExit = yield* Effect.exit(
          team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, {
            type: "thread.metadata.update",
            commandId: CommandId.make("cmd-continuation-hijack"),
            threadId: bobLocalThreadId,
            continuation: {
              messageId: MessageId.make("msg-continuation-hijack"),
              text: "Sneaky continuation execution",
            },
          }),
        );
        expect(continuationHijackExit._tag).toBe("Failure");

        const settleHijackExit = yield* Effect.exit(
          team.assertAndNormalizeDispatchCommand(aliceSession.sessionId, {
            type: "thread.settle",
            commandId: CommandId.make("cmd-settle-hijack"),
            threadId: bobLocalThreadId,
          }),
        );
        expect(settleHijackExit._tag).toBe("Failure");

        // Bijective encoding prevents collisions on custom IDs containing `:run:` / `:msg:`.
        expect(localSyncMirroredRunId(ThreadId.make("a"), "b:run:c")).not.toBe(
          localSyncMirroredRunId(ThreadId.make("a:run:b"), "c"),
        );
        expect(localSyncMirroredMessageId(ThreadId.make("a"), "b:msg:c")).not.toBe(
          localSyncMirroredMessageId(ThreadId.make("a:msg:b"), "c"),
        );

        // 7. syncLocalThread rejects spoofing registered team environment IDs or unassigned projects.
        const spoofedEnvExit = yield* Effect.exit(
          team.syncLocalThread({
            sessionId: bob.sessionId,
            payload: {
              threadId: ThreadId.make("thread-spoof-env"),
              projectId,
              title: "Spoofed env",
              branch: null,
              executionEnvironmentId: restrictedEnvId,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.3-codex",
                options: [],
              },
              runs: [],
              messages: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        );
        expect(spoofedEnvExit._tag).toBe("Failure");

        const unassignedProjExit = yield* Effect.exit(
          team.syncLocalThread({
            sessionId: bob.sessionId,
            payload: {
              threadId: ThreadId.make("thread-unassigned-proj"),
              projectId: ProjectId.make("proj-not-assigned"),
              title: "Unassigned project",
              branch: null,
              executionEnvironmentId: EnvironmentId.make("env-bob-laptop"),
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.3-codex",
                options: [],
              },
              runs: [],
              messages: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        );
        expect(unassignedProjExit._tag).toBe("Failure");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "fails closed on TeamRepository errors across read, batch filter, post, execute, and prepare",
    () => {
      const repoError = new TeamRepository.TeamRepositoryError({
        operation: "injected",
        cause: new Error("SQLite busy"),
      });
      const failingRepoLayer = Layer.mock(TeamRepository.TeamRepository)({
        getWorkspace: () => Effect.fail(repoError),
        getThreadAttribution: () => Effect.fail(repoError),
        getMemberForSession: () => Effect.fail(repoError),
        listViews: () => Effect.fail(repoError),
        listThreadAttributions: () => Effect.fail(repoError),
        findThreadIdByAttachmentSegment: () => Effect.fail(repoError),
      });
      const failingServiceLayer = TeamService.layer.pipe(
        Layer.provideMerge(failingRepoLayer),
        Layer.provideMerge(
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            revoke: () => Effect.succeed(false),
          }),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );
      const sid = AuthSessionId.make("sess-fault");
      const tid = ThreadId.make("thread-fault");
      return Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        expect(yield* team.isTeamConfigured()).toBe(true);
        expect(yield* team.canReadThread(sid, tid)).toBe(false);
        expect(yield* team.canReadAttachment(sid, `${tid}-att-1`)).toBe(false);
        expect(yield* team.canPostInThread(sid, tid)).toBe(false);
        expect((yield* team.filterReadableThreadIds(sid, [tid])).size).toBe(0);
        expect((yield* Effect.exit(team.assertCanExecuteOnThreadEnvironment(sid, tid)))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.exit(team.assertCanAccessLocalEnvironment(sid)))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.exit(team.getRemotePairingSubject(sid)))._tag).toBe("Failure");
        expect((yield* Effect.exit(team.assertCanLaunchThread({ sessionId: sid })))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* Effect.exit(team.prepareThreadAttribution({ sessionId: sid, threadId: tid })))
            ._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(failingServiceLayer));
    },
  );

  it.effect(
    "drains pending remote revocations with unlinkAfterRevoke safely across omitted peerLinks, unlink failure, and environment filtering",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({
          subject: "owner-alice",
          method: "browser-session-cookie",
          scopes: AuthStandardClientScopes,
        });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });

        const envA = EnvironmentId.make("env-remote-a");
        const envB = EnvironmentId.make("env-remote-b");
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envA,
            name: "Remote A",
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          },
        });
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envB,
            name: "Remote B",
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          },
        });

        let remoteOnline = false;
        let unlinkSucceeds = false;
        const revokedCalls: Array<{ environmentId: EnvironmentId; prefix: string }> = [];
        const unlinkedEnvs: Array<EnvironmentId> = [];

        const mockPeerClientPairing = {
          revokeSubject: (environmentId: EnvironmentId, prefix: string) =>
            Effect.sync(() => {
              revokedCalls.push({ environmentId, prefix });
              return remoteOnline
                ? { ok: true as const, revokedSessions: 1, revokedPairingLinks: 0 }
                : { ok: false as const, reason: "unreachable" as const };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerClientPairing"]
        >;

        const mockPeerLinks = {
          unlink: (environmentId: EnvironmentId) =>
            unlinkSucceeds
              ? Effect.sync(() => {
                  unlinkedEnvs.push(environmentId);
                  return { unlinked: true };
                })
              : Effect.fail({ _tag: "MockPeerUnlinkFailed" } as const),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerLinks"]
        >;

        // Detaching while offline queues a pending revocation with unlinkAfterRevoke = true.
        yield* team.detachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: { environmentId: envA },
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(unlinkedEnvs).toEqual([]);

        // Bring remote online.
        remoteOnline = true;

        // 1. Filtering to envB must not touch envA's pending revocation.
        revokedCalls.length = 0;
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
          environmentId: envB,
        });
        expect(revokedCalls).toEqual([]);

        // 2. Draining WITHOUT peerLinks must not drop an unlinkAfterRevoke row.
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
        });
        expect(revokedCalls).toEqual([]);

        // 3. Draining WITH peerLinks while unlink fails keeps the pending row for retry.
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(revokedCalls.length).toBe(1);
        expect(unlinkedEnvs).toEqual([]);

        // 4. Once unlink succeeds, the row is drained and deleted; a subsequent drain is a no-op.
        unlinkSucceeds = true;
        revokedCalls.length = 0;
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(revokedCalls.length).toBe(1);
        expect(unlinkedEnvs).toEqual([envA]);

        revokedCalls.length = 0;
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(revokedCalls).toEqual([]);

        // 5. Re-attaching an offline-detached environment clears unlinkAfterRevoke so drain
        // still revokes old sessions WITHOUT unlinking the re-attached environment.
        remoteOnline = false;
        unlinkedEnvs.length = 0;
        revokedCalls.length = 0;
        yield* team.detachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: { environmentId: envB },
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(unlinkedEnvs).toEqual([]);

        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envB,
            name: "Remote B Reattached",
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          },
        });

        remoteOnline = true;
        revokedCalls.length = 0;
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        expect(revokedCalls.length).toBe(1);
        expect(revokedCalls[0]?.environmentId).toBe(envB);
        expect(unlinkedEnvs).toEqual([]);

        // 6. Concurrent re-attach WHILE drainPendingRemoteRevocations is mid-revokeSubject must
        // never lose its newly re-attached peer link when the in-flight drain finishes.
        remoteOnline = false;
        unlinkedEnvs.length = 0;
        yield* team.detachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: { environmentId: envB },
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });
        const revokeStarted = yield* Deferred.make<void>();
        const releaseRevoke = yield* Deferred.make<void>();
        const slowPeerClientPairing = {
          revokeSubject: (environmentId: EnvironmentId, prefix: string) =>
            Effect.gen(function* () {
              revokedCalls.push({ environmentId, prefix });
              yield* Deferred.succeed(revokeStarted, undefined);
              yield* Deferred.await(releaseRevoke);
              return { ok: true as const, revokedSessions: 1, revokedPairingLinks: 0 };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerClientPairing"]
        >;

        revokedCalls.length = 0;
        const drainFiber = yield* Effect.forkChild(
          team.drainPendingRemoteRevocations({
            peerClientPairing: slowPeerClientPairing,
            peerLinks: mockPeerLinks,
          }),
        );
        yield* Deferred.await(revokeStarted);
        // Re-attach envB while the drain's revokeSubject call is still in flight.
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envB,
            name: "Remote B Concurrent Reattach",
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          },
        });
        yield* Deferred.succeed(releaseRevoke, undefined);
        yield* Fiber.join(drainFiber);
        expect(revokedCalls.length).toBe(1);
        expect(unlinkedEnvs).toEqual([]);

        // 7. Concurrent drain finishing revokeSubject WHILE attachEnvironment is mid-linkUnlessLinked
        // must wait for attachEnvironment to commit and must NOT unlink the newly linked peer.
        remoteOnline = false;
        unlinkedEnvs.length = 0;
        yield* team.detachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: { environmentId: envB },
          peerClientPairing: mockPeerClientPairing,
          peerLinks: mockPeerLinks,
        });

        const linkResolved = yield* Deferred.make<void>();
        const releaseLink = yield* Deferred.make<void>();
        const drainRevoked = yield* Deferred.make<void>();
        const slowLinkPeerLinks = {
          linkUnlessLinked: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(linkResolved, undefined);
              yield* Deferred.await(releaseLink);
              return { link: { environmentId: envB, label: "Remote B Linked" } };
            }),
          unlink: (environmentId: EnvironmentId) =>
            Effect.sync(() => {
              unlinkedEnvs.push(environmentId);
              return { unlinked: true };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerLinks"]
        >;
        const signalRevokePairing = {
          revokeSubject: (environmentId: EnvironmentId, prefix: string) =>
            Effect.gen(function* () {
              revokedCalls.push({ environmentId, prefix });
              yield* Deferred.succeed(drainRevoked, undefined);
              return { ok: true as const, revokedSessions: 1, revokedPairingLinks: 0 };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerClientPairing"]
        >;

        revokedCalls.length = 0;
        const attachFiber = yield* Effect.forkChild(
          team.attachEnvironment({
            sessionId: aliceSession.sessionId,
            payload: {
              url: "http://remote-b.test",
              pairingCode: "pair-b-1",
              name: "Remote B Re-Linked",
              accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
            },
            peerLinks: slowLinkPeerLinks,
          }),
        );
        yield* Deferred.await(linkResolved);

        // Drain completes remote revokeSubject while attachEnvironment is paused after link resolution.
        const drainDuringAttachFiber = yield* Effect.forkChild(
          team.drainPendingRemoteRevocations({
            peerClientPairing: signalRevokePairing,
            peerLinks: slowLinkPeerLinks,
          }),
        );
        yield* Deferred.await(drainRevoked);
        yield* Effect.yieldNow;
        expect(unlinkedEnvs).toEqual([]);

        yield* Deferred.succeed(releaseLink, undefined);
        const reattached = yield* Fiber.join(attachFiber);
        yield* Fiber.join(drainDuringAttachFiber);
        expect(reattached.environmentId).toBe(envB);
        expect(revokedCalls.length).toBe(1);
        expect(unlinkedEnvs).toEqual([]);

        // 8. Concurrent ACL revocation during an in-flight pairRemoteEnvironmentForSession waits
        // for the remote request to settle, denies returning the credential to the revoked member,
        // and runs revokeSubject strictly AFTER the remote pairing request finishes.
        const bobInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob-pair" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob-pair",
          client: { deviceType: "desktop" },
        });
        const bobVerified = yield* sessions.verify(bobRedeemed.accessToken);

        const pairingStarted = yield* Deferred.make<void>();
        const releasePairing = yield* Deferred.make<void>();
        const eventOrder: Array<string> = [];
        const racingPairing = {
          request: (_input: { readonly environmentId: EnvironmentId }) =>
            Effect.gen(function* () {
              eventOrder.push("pair:start");
              yield* Deferred.succeed(pairingStarted, undefined);
              yield* Deferred.await(releasePairing);
              eventOrder.push("pair:remote-minted");
              return {
                type: "credential" as const,
                environmentId: envB,
                label: "Remote B",
                urls: ["http://remote-b.test"],
                credential: "should-never-reach-revoked-caller",
                expiresAt: "2026-12-01T00:00:00.000Z",
              };
            }),
          revokeSubject: (environmentId: EnvironmentId, prefix: string) =>
            Effect.sync(() => {
              eventOrder.push(`revoke:${environmentId}:${prefix}`);
              revokedCalls.push({ environmentId, prefix });
              return { ok: true as const, revokedSessions: 0, revokedPairingLinks: 1 };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerClientPairing"]
        >;

        revokedCalls.length = 0;
        const pairFiber = yield* Effect.forkChild(
          Effect.exit(
            team.pairRemoteEnvironmentForSession({
              sessionId: bobVerified.sessionId,
              scopes: bobVerified.scopes,
              pairingInput: { environmentId: envB },
              peerClientPairing: racingPairing,
              peerLinks: mockPeerLinks,
            }),
          ),
        );
        yield* Deferred.await(pairingStarted);

        // Alice revokes regular access on envB while Bob's remote pairing request is in flight.
        const revokeAclFiber = yield* Effect.forkChild(
          team.updateEnvironment({
            sessionId: aliceSession.sessionId,
            payload: {
              environmentId: envB,
              accessRule: { roles: ["owner", "admin"], memberIds: [] },
            },
            peerClientPairing: racingPairing,
          }),
        );
        yield* Effect.yieldNow;
        // Revocation barrier must hold revokeSubject until the in-flight pairing finishes on remote.
        expect(revokedCalls).toEqual([]);

        yield* Deferred.succeed(releasePairing, undefined);
        const pairExit = yield* Fiber.join(pairFiber);
        yield* Fiber.join(revokeAclFiber);

        expect(pairExit._tag).toBe("Failure");
        expect(revokedCalls.length).toBe(1);
        expect(revokedCalls[0]?.environmentId).toBe(envB);
        expect(revokedCalls[0]?.prefix).toContain(`:${bobRedeemed.member.id}:`);
        expect(eventOrder[0]).toBe("pair:start");
        expect(eventOrder[1]).toBe("pair:remote-minted");
        expect(eventOrder[2]?.startsWith(`revoke:${envB}:`)).toBe(true);

        // 9. Demoting an admin -> regular revokes their privileged remote grants across ALL
        // linked/registered environments (even environments still accessible to regular members!),
        // and blocks an in-flight admin-scoped pairing on a still-accessible environment.
        const envShared = EnvironmentId.make("env-shared-all-roles");
        const envUnregistered = EnvironmentId.make("env-unregistered-peer");
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envShared,
            name: "Shared Worker",
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          },
        });
        const claraInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "admin", prefilledPseudo: "clara-demote" },
        });
        const claraRedeemed = yield* team.redeemInvite({
          token: claraInvite.token,
          pseudo: "clara-demote",
          client: { deviceType: "desktop" },
        });
        const claraVerified = yield* sessions.verify(claraRedeemed.accessToken);
        expect(claraVerified.scopes).toContain(AuthAccessWriteScope);

        const claraPairStarted = yield* Deferred.make<void>();
        const releaseClaraPair = yield* Deferred.make<void>();
        const demoteEvents: Array<string> = [];
        const demoteRevokedEnvs: Array<EnvironmentId> = [];
        const demotePairing = {
          request: (_input: { readonly environmentId: EnvironmentId }) =>
            Effect.gen(function* () {
              demoteEvents.push("pair:start");
              yield* Deferred.succeed(claraPairStarted, undefined);
              yield* Deferred.await(releaseClaraPair);
              demoteEvents.push("pair:remote-minted");
              return {
                type: "credential" as const,
                environmentId: envShared,
                label: "Shared Worker",
                urls: ["http://shared.test"],
                credential: "over-privileged-admin-cred",
                expiresAt: "2026-12-01T00:00:00.000Z",
              };
            }),
          revokeSubject: (environmentId: EnvironmentId, prefix: string) =>
            Effect.sync(() => {
              demoteEvents.push(`revoke:${environmentId}:${prefix}`);
              demoteRevokedEnvs.push(environmentId);
              return { ok: true as const, revokedSessions: 1, revokedPairingLinks: 1 };
            }),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerClientPairing"]
        >;
        const demotePeerLinks = {
          list: Effect.succeed([
            { environmentId: envShared, label: "Shared Worker" },
            { environmentId: envUnregistered, label: "Unregistered Peer" },
          ]),
        } as unknown as NonNullable<
          Parameters<
            TeamService.TeamService["Service"]["drainPendingRemoteRevocations"]
          >[0]["peerLinks"]
        >;

        const claraPairFiber = yield* Effect.forkChild(
          Effect.exit(
            team.pairRemoteEnvironmentForSession({
              sessionId: claraVerified.sessionId,
              scopes: claraVerified.scopes,
              pairingInput: { environmentId: envShared },
              peerClientPairing: demotePairing,
              peerLinks: demotePeerLinks,
            }),
          ),
        );
        yield* Deferred.await(claraPairStarted);

        const demoteFiber = yield* Effect.forkChild(
          team.updateMemberRole({
            sessionId: aliceSession.sessionId,
            payload: { memberId: claraRedeemed.member.id, role: "regular" },
            peerClientPairing: demotePairing,
            peerLinks: demotePeerLinks,
          }),
        );
        yield* Effect.yieldNow;
        expect(demoteRevokedEnvs).toEqual([]);

        yield* Deferred.succeed(releaseClaraPair, undefined);
        const claraPairExit = yield* Fiber.join(claraPairFiber);
        yield* Fiber.join(demoteFiber);

        expect(claraPairExit._tag).toBe("Failure");
        expect(demoteRevokedEnvs).toContain(envShared);
        expect(demoteRevokedEnvs).toContain(envUnregistered);
        expect(demoteEvents[0]).toBe("pair:start");
        expect(demoteEvents[1]).toBe("pair:remote-minted");
        expect(demoteEvents.slice(2).every((e) => e.startsWith("revoke:"))).toBe(true);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces Milestone 6 RBAC: owner/admin-only team providers, modo+ pure-Markdown skills and pre-prompts, and token revocation on suspension",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-m6" });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "M6 Org", ownerPseudo: "alice" },
        });
        const charlieInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "modo", prefilledPseudo: "charlie" },
        });
        const charlieRedeemed = yield* team.redeemInvite({
          token: charlieInvite.token,
          pseudo: "charlie",
          client: testClient,
        });
        const charlieSession = yield* sessions.verify(charlieRedeemed.accessToken);

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

        // Provider management is strictly owner/admin only (modo & regular rejected!).
        const modoProviderExit = yield* Effect.exit(
          team.upsertProvider({
            sessionId: charlieSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("company-llm"),
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Company LLM",
              deliveryStrategy: "proxy",
              upstreamBaseUrl: "https://llm.example",
              apiKey: "secret",
            },
          }),
        );
        expect(modoProviderExit._tag).toBe("Failure");
        expect(
          (yield* Effect.exit(team.assertCanManageServerProviders(charlieSession.sessionId)))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(team.assertCanManageServerProviders(bobSession.sessionId)))._tag,
        ).toBe("Failure");
        yield* team.assertCanManageServerProviders(aliceSession.sessionId);

        const provider = yield* team.upsertProvider({
          sessionId: aliceSession.sessionId,
          payload: {
            providerInstanceId: ProviderInstanceId.make("company-llm"),
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Company LLM",
            deliveryStrategy: "proxy",
            upstreamBaseUrl: "https://llm.example",
            apiKey: "secret",
          },
        });
        expect(provider.hasSecret).toBe(true);

        // Modo Charlie CAN create pure-Markdown skills & pre-prompts, but executable scripts are rejected!
        const badSkillExit = yield* Effect.exit(
          team.upsertSkill({
            sessionId: charlieSession.sessionId,
            payload: {
              slug: "bad-script",
              providerDriver: "*",
              skillMd: "---\nname: bad-script\ndescription: Bad\n---\nBody",
              references: [{ path: "run.sh", content: "echo pwned" }],
            },
          }),
        );
        expect(badSkillExit._tag).toBe("Failure");

        const skill = yield* team.upsertSkill({
          sessionId: charlieSession.sessionId,
          payload: {
            slug: "team-review",
            providerDriver: "*",
            skillMd: "---\nname: team-review\ndescription: Team review\n---\nCheck tests.",
            references: [{ path: "checklist.md", content: "- Run tests" }],
          },
        });
        expect(skill.updatedByMemberId).toBe(charlieRedeemed.member.id);

        const preprompt = yield* team.upsertPreprompt({
          sessionId: charlieSession.sessionId,
          payload: {
            name: "Security Guard",
            providerDriver: "*",
            injectionScope: "turn",
            content: "Never commit company keys.",
          },
        });
        expect(preprompt.injectionScope).toBe("turn");

        // Regular Bob CANNOT write skills or pre-prompts, CAN read them in getState!
        const bobSkillExit = yield* Effect.exit(
          team.upsertSkill({
            sessionId: bobSession.sessionId,
            payload: {
              slug: "bob-skill",
              providerDriver: "*",
              skillMd: "---\nname: bob-skill\ndescription: No\n---\nBody",
            },
          }),
        );
        expect(bobSkillExit._tag).toBe("Failure");

        const bobState = yield* team.getState(bobSession.sessionId);
        expect(bobState.providers).toHaveLength(1);
        expect(bobState.skills).toHaveLength(1);
        expect(bobState.preprompts).toHaveLength(1);
        expect(bobState.assetsRevision).toBeGreaterThanOrEqual(2);

        // C5: regular and modo sessions MUST NOT hold AuthProvidersManageScope.
        expect(bobSession.scopes).not.toContain(AuthProvidersManageScope);
        expect(charlieSession.scopes).not.toContain(AuthProvidersManageScope);

        // C2: local binding host guard rejects local-binding mutations on a configured Team Server.
        expect((yield* Effect.exit(team.assertLocalBindingHostAllowed()))._tag).toBe("Failure");

        // M1: double-prefixed team:* providerInstanceId and invalid oauthTokenEndpoint are rejected, and clearSecret clears stored secrets.
        const prefixedExit = yield* Effect.exit(
          team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("team:other:foo"),
              driver: ProviderDriverKind.make("codex"),
              deliveryStrategy: "remote-only",
            },
          }),
        );
        expect(prefixedExit._tag).toBe("Failure");

        const badEndpointExit = yield* Effect.exit(
          team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("bad-oauth"),
              driver: ProviderDriverKind.make("antigravity"),
              deliveryStrategy: "token-lease",
              oauthTokenEndpoint: "ftp://evil.example/token",
            },
          }),
        );
        expect(badEndpointExit._tag).toBe("Failure");

        const cleared = yield* team.upsertProvider({
          sessionId: aliceSession.sessionId,
          payload: {
            providerInstanceId: ProviderInstanceId.make("company-llm"),
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Company LLM",
            deliveryStrategy: "proxy",
            upstreamBaseUrl: "https://llm.example",
            clearSecret: true,
          },
        });
        expect(cleared.hasSecret).toBe(false);

        // M2: toggling enabled or injectionScope updates contentHash & revision.
        const toggledSkill = yield* team.upsertSkill({
          sessionId: charlieSession.sessionId,
          payload: {
            skillId: skill.id,
            slug: "team-review",
            providerDriver: "*",
            skillMd: "---\nname: team-review\ndescription: Team review\n---\nCheck tests.",
            references: [{ path: "checklist.md", content: "- Run tests" }],
            enabled: false,
          },
        });
        expect(toggledSkill.contentHash).not.toBe(skill.contentHash);

        const toggledPreprompt = yield* team.upsertPreprompt({
          sessionId: charlieSession.sessionId,
          payload: {
            prepromptId: preprompt.id,
            name: "Security Guard",
            providerDriver: "*",
            injectionScope: "thread",
            content: "Never commit company keys.",
          },
        });
        expect(toggledPreprompt.contentHash).not.toBe(preprompt.contentHash);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  const swapAllowedGitHubOrigins = (value: string | undefined): string | undefined => {
    const prev = process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
    if (value === undefined) {
      delete process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
    } else {
      process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS = value;
    }
    return prev;
  };

  it.effect(
    "Milestone 7: isolates member & automation GitHub identities across snapshots/streams and revokes on disconnect or suspension",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const githubRepo = yield* TeamGitHubRepository.TeamGitHubRepository;
        const sessions = yield* SessionStore.SessionStore;

        const apiServer = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<{ readonly server: NodeHttp.Server; readonly origin: string }>(
                (resolve) => {
                  const server = NodeHttp.createServer((req, res) => {
                    const auth = req.headers.authorization ?? "";
                    if (req.url === "/user") {
                      if (auth === "Bearer ghp_alice_secret") {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(
                          JSON.stringify({
                            login: "alice-gh",
                            name: "Alice Owner",
                            email: "alice@acme.dev",
                          }),
                        );
                        return;
                      }
                      if (auth === "Bearer ghp_bob_secret") {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(
                          JSON.stringify({
                            login: "bob-gh",
                            name: "Bob Regular",
                            email: "bob@acme.dev",
                          }),
                        );
                        return;
                      }
                      if (auth === "Bearer ghp_bot_secret") {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(
                          JSON.stringify({
                            login: "acme-bot",
                            name: "Acme Bot",
                            email: "bot@acme.dev",
                          }),
                        );
                        return;
                      }
                    }
                    res.writeHead(401, { "content-type": "application/json" });
                    res.end(JSON.stringify({ message: "Bad credentials" }));
                  });
                  server.listen(0, "127.0.0.1", () => {
                    const addr = server.address();
                    if (!addr || typeof addr === "string") {
                      throw new Error("Expected TCP address");
                    }
                    resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
                  });
                },
              ),
          ),
          ({ server }) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );

        const ownerSession = yield* sessions.issue({ subject: "owner" });
        yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "GitHub Privacy Corp", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob", maxUses: 1 },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobSession = yield* sessions.verify(bobRedeemed.accessToken);

        const credentialChanges: Array<{ readonly kind: string; readonly memberId?: string }> = [];
        yield* team.registerGitHubCredentialChangeHook((event) =>
          Effect.sync(() => {
            credentialChanges.push(
              event.kind === "member"
                ? { kind: event.kind, memberId: event.memberId }
                : { kind: event.kind },
            );
          }),
        );

        const bobStreamFiber = yield* team
          .streamState(bobSession.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        const aliceStreamFiber = yield* team
          .streamState(ownerSession.sessionId)
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;

        yield* Effect.acquireRelease(
          Effect.sync(() => swapAllowedGitHubOrigins(apiServer.origin)),
          (prev) =>
            Effect.sync(() => {
              swapAllowedGitHubOrigins(prev);
            }),
        );

        // Alice connects her PAT -> Alice sees it, Bob NEVER sees Alice's identity or token.
        const aliceIdentity = yield* team.connectMyGitHub({
          sessionId: ownerSession.sessionId,
          payload: {
            token: "ghp_alice_secret",
            apiBaseUrl: apiServer.origin,
          },
        });
        expect(aliceIdentity.githubLogin).toBe("alice-gh");

        // Owner sets optional Team Automation account -> only admin/owner sees it.
        const automationIdentity = yield* team.setAutomationGitHub({
          sessionId: ownerSession.sessionId,
          payload: {
            token: "ghp_bot_secret",
            apiBaseUrl: apiServer.origin,
          },
        });
        expect(automationIdentity.githubLogin).toBe("acme-bot");

        // Regular Bob CANNOT set or clear the Team Automation account.
        const bobAutoExit = yield* Effect.exit(
          team.setAutomationGitHub({
            sessionId: bobSession.sessionId,
            payload: { token: "ghp_bot_secret", apiBaseUrl: apiServer.origin },
          }),
        );
        expect(bobAutoExit._tag).toBe("Failure");

        // Bob connects his own PAT so we can verify suspension wipes his secret and fires the hook.
        const bobIdentity = yield* team.connectMyGitHub({
          sessionId: bobSession.sessionId,
          payload: {
            token: "ghp_bob_secret",
            apiBaseUrl: apiServer.origin,
          },
        });
        expect(bobIdentity.githubLogin).toBe("bob-gh");

        const bobState = yield* team.getState(bobSession.sessionId);
        expect(bobState.myGitHubIdentity?.githubLogin).toBe("bob-gh");
        expect(bobState.automationGitHubIdentity).toBeNull();

        const aliceEvents = Array.from(yield* Fiber.join(aliceStreamFiber));
        expect(aliceEvents.map((e) => e.type)).toEqual([
          "snapshot",
          "myGitHubIdentityUpdated",
          "automationGitHubIdentityUpdated",
        ]);
        const bobEvents = Array.from(yield* Fiber.join(bobStreamFiber));
        expect(bobEvents.map((e) => e.type)).toEqual(["snapshot", "myGitHubIdentityUpdated"]);

        // Suspending Bob triggers immediate lease revocation hook; removing Bob also wipes his stored credential.
        yield* team.updateMemberStatus({
          sessionId: ownerSession.sessionId,
          payload: { memberId: bobRedeemed.member.id, status: "suspended" },
        });
        expect(
          credentialChanges.some(
            (entry) => entry.kind === "member" && entry.memberId === bobRedeemed.member.id,
          ),
        ).toBe(true);
        yield* team.updateMemberStatus({
          sessionId: ownerSession.sessionId,
          payload: { memberId: bobRedeemed.member.id, status: "removed" },
        });
        expect(Option.isNone(yield* githubRepo.getMemberCredential(bobRedeemed.member.id))).toBe(
          true,
        );

        // Alice disconnects her own GitHub identity & clears team automation.
        yield* team.disconnectMyGitHub({ sessionId: ownerSession.sessionId });
        yield* team.clearAutomationGitHub({ sessionId: ownerSession.sessionId });
        const aliceFinalState = yield* team.getState(ownerSession.sessionId);
        expect(aliceFinalState.myGitHubIdentity).toBeNull();
        expect(aliceFinalState.automationGitHubIdentity).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  );

  it.effect(
    "Milestone 8: manages scheduled-task RBAC/anti-escalation/webhook redaction, and team-owned threads",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;

        const ownerSession = yield* sessions.issue({ subject: "m8-owner" });
        const init = yield* team.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Platform Team", ownerPseudo: "alice" },
        });

        const modoInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "modo", prefilledPseudo: "charlie" },
        });
        const modoRedeemed = yield* team.redeemInvite({
          token: modoInvite.token,
          pseudo: "charlie",
          client: testClient,
        });
        const modoSession = yield* sessions.verify(modoRedeemed.accessToken);

        const regularInvite = yield* team.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const regularRedeemed = yield* team.redeemInvite({
          token: regularInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const regularSession = yield* sessions.verify(regularRedeemed.accessToken);

        const projectId = ProjectId.make("proj-m8");
        const baseTaskInput = {
          title: "Daily Triage",
          prompt: "Triage open issues",
          enabled: true,
          schedule: { type: "webhook" as const, signature: null },
          projectId,
          threadId: null,
          workspaceStrategy: { type: "root" as const },
          modelSelection: {
            instanceId: ProviderInstanceId.make("devReplay"),
            model: "multi-turn",
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          creationSource: "web" as const,
        };

        // Regular cannot create tasks.
        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: regularSession.sessionId,
              input: baseTaskInput,
              existingTask: null,
            }),
          ))._tag,
        ).toBe("Failure");

        // Modo can create a minimal unlocked task, but CANNOT set locked or elevated.
        const modoAuthOpt = yield* team.authorizeScheduledTaskUpsert({
          sessionId: modoSession.sessionId,
          input: baseTaskInput,
          existingTask: null,
        });
        expect(Option.isSome(modoAuthOpt)).toBe(true);
        const minTaskId = ScheduledTaskId.make("task-m8-min");
        yield* team.saveScheduledTaskMeta({
          ...Option.getOrThrow(modoAuthOpt),
          taskId: minTaskId,
        });

        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: modoSession.sessionId,
              input: { ...baseTaskInput, teamMeta: { locked: true } },
              existingTask: null,
            }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: modoSession.sessionId,
              input: { ...baseTaskInput, teamMeta: { mcpAccessLevel: "elevated" } },
              existingTask: null,
            }),
          ))._tag,
        ).toBe("Failure");

        // Owner creates a locked + elevated task -> modo cannot mutate or see its webhook.
        const elevAuthOpt = yield* team.authorizeScheduledTaskUpsert({
          sessionId: ownerSession.sessionId,
          input: {
            ...baseTaskInput,
            title: "Admin Release",
            teamMeta: { locked: true, mcpAccessLevel: "elevated" },
          },
          existingTask: null,
        });
        const elevTaskId = ScheduledTaskId.make("task-m8-elev");
        yield* team.saveScheduledTaskMeta({
          ...Option.getOrThrow(elevAuthOpt),
          taskId: elevTaskId,
        });

        expect(
          (yield* Effect.exit(team.assertCanMutateScheduledTask(modoSession.sessionId, elevTaskId)))
            ._tag,
        ).toBe("Failure");
        yield* team.assertCanMutateScheduledTask(modoSession.sessionId, minTaskId);
        yield* team.assertCanMutateScheduledTask(ownerSession.sessionId, elevTaskId);

        const mkTask = (id: ScheduledTaskId, title: string): ScheduledTask => ({
          id,
          title,
          prompt: "Prompt",
          enabled: true,
          schedule: { type: "webhook", signature: null },
          webhook: { path: `/api/webhooks/${id}`, url: null, hasSecret: true },
          projectId,
          threadId: null,
          workspaceStrategy: { type: "root" },
          modelSelection: baseTaskInput.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "never",
          lastRunError: null,
          runCount: 0,
        });
        const allTasks = [mkTask(minTaskId, "Daily Triage"), mkTask(elevTaskId, "Admin Release")];

        // Regular sees both tasks read-only with BOTH webhooks redacted.
        const regularVisible = yield* team.filterReadableScheduledTasks(
          regularSession.sessionId,
          allTasks,
        );
        expect(regularVisible).toHaveLength(2);
        expect(regularVisible.every((t) => t.webhook === undefined)).toBe(true);

        // Modo sees webhook for minimal task, NOT for locked/elevated task.
        const modoVisible = yield* team.filterReadableScheduledTasks(
          modoSession.sessionId,
          allTasks,
        );
        expect(modoVisible.find((t) => t.id === minTaskId)?.webhook).toBeDefined();
        expect(modoVisible.find((t) => t.id === elevTaskId)?.webhook).toBeUndefined();

        // Owner sees webhooks for both tasks.
        const ownerVisible = yield* team.filterReadableScheduledTasks(
          ownerSession.sessionId,
          allTasks,
        );
        expect(ownerVisible.every((t) => t.webhook !== undefined)).toBe(true);

        // Team-owned thread attribution & turn principal + interrupt/notification checks.
        const autoThreadId = ThreadId.make("thread-m8-auto");
        const prepared = yield* team.prepareTeamAutomationThreadAttribution({
          taskId: minTaskId,
          threadId: autoThreadId,
          projectId,
        });
        expect(prepared).toBe(true);
        const attr = Option.getOrThrow(yield* repo.getThreadAttribution(autoThreadId));
        expect(attr.ownerKind).toBe("team");
        expect(attr.creatorMemberId).toBeNull();

        const principalOpt = yield* team.recordTeamAutomationTurn({
          threadId: autoThreadId,
          turnId: "run-m8-1",
          taskId: minTaskId,
          projectId,
        });
        expect(Option.isSome(principalOpt)).toBe(true);
        expect(Option.getOrThrow(principalOpt).mcpAccessLevel).toBe("minimal");

        const resolvedPrincipal = yield* team.resolveTurnPrincipal({
          threadId: autoThreadId,
          runId: "run-m8-1",
        });
        expect(Option.getOrThrow(resolvedPrincipal).kind).toBe("team_automation");

        // Zero default notifications on team-owned thread; owner and modo (on unlocked thread) can interrupt, regular cannot, and locked blocks modo.
        const defaultRecipients = yield* team.listNotificationRecipientsForThread({
          threadId: autoThreadId,
          turnId: "run-m8-1",
        });
        expect(defaultRecipients.isTeamThread).toBe(true);
        expect(defaultRecipients.recipientMemberIds).toHaveLength(0);
        yield* team.assertCanInterruptThread(ownerSession.sessionId, autoThreadId, "run-m8-1");
        yield* team.assertCanInterruptThread(modoSession.sessionId, autoThreadId, "run-m8-1");
        expect(
          (yield* Effect.exit(
            team.assertCanInterruptThread(regularSession.sessionId, autoThreadId, "run-m8-1"),
          ))._tag,
        ).toBe("Failure");
        yield* team.setThreadLocked({
          sessionId: ownerSession.sessionId,
          payload: { threadId: autoThreadId, locked: true },
        });
        expect(
          (yield* Effect.exit(
            team.assertCanInterruptThread(modoSession.sessionId, autoThreadId, "run-m8-1"),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertCanInterruptThread(ownerSession.sessionId, autoThreadId, "run-m8-1");
        yield* team.setThreadLocked({
          sessionId: ownerSession.sessionId,
          payload: { threadId: autoThreadId, locked: false },
        });

        // Webhook delivery logs follow the same visibility rules as the live webhook URL.
        yield* team.assertCanReadScheduledTaskWebhooks(modoSession.sessionId, minTaskId);
        yield* team.assertCanReadScheduledTaskWebhooks(ownerSession.sessionId, elevTaskId);
        expect(
          (yield* Effect.exit(
            team.assertCanReadScheduledTaskWebhooks(regularSession.sessionId, minTaskId),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertCanReadScheduledTaskWebhooks(modoSession.sessionId, elevTaskId),
          ))._tag,
        ).toBe("Failure");

        // Unattributed scheduled tasks (missing sidecar meta) fail closed to owner/admin only.
        const legacyTaskId = ScheduledTaskId.make("task-m8-legacy-unattributed");
        const legacyTask = mkTask(legacyTaskId, "Pre-M8 Admin Task");
        expect(
          yield* team.filterReadableScheduledTasks(modoSession.sessionId, [legacyTask]),
        ).toEqual([]);
        expect(
          yield* team.filterReadableScheduledTasks(regularSession.sessionId, [legacyTask]),
        ).toEqual([]);
        expect(
          yield* team.filterReadableScheduledTasks(ownerSession.sessionId, [legacyTask]),
        ).toHaveLength(1);
        expect(
          (yield* Effect.exit(
            team.assertCanMutateScheduledTask(modoSession.sessionId, legacyTaskId),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertCanReadScheduledTaskWebhooks(modoSession.sessionId, legacyTaskId),
          ))._tag,
        ).toBe("Failure");

        // Bound-thread RBAC: once an admin locks a bound thread, modo cannot edit (even omitting
        // threadId), unbind, toggle, delete, rotate, or see webhook deliveries for that task.
        const boundThreadId = ThreadId.make("thread-m8-bound");
        yield* team.recordThreadCreated({
          sessionId: modoSession.sessionId,
          threadId: boundThreadId,
          viewId: init.team.defaultViewId,
        });
        const boundTaskId = ScheduledTaskId.make("task-m8-bound");
        const boundAuth = yield* team.authorizeScheduledTaskUpsert({
          sessionId: modoSession.sessionId,
          input: { ...baseTaskInput, threadId: boundThreadId },
          existingTask: null,
        });
        yield* team.saveScheduledTaskMeta({
          ...Option.getOrThrow(boundAuth),
          taskId: boundTaskId,
        });
        const boundExistingTask: ScheduledTask = {
          ...mkTask(boundTaskId, "Bound Task"),
          threadId: boundThreadId,
          threadMode: "continue",
        };
        yield* team.setThreadLocked({
          sessionId: ownerSession.sessionId,
          payload: { threadId: boundThreadId, locked: true },
        });
        // Omitted threadId retains boundThreadId -> must fail for modo.
        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: modoSession.sessionId,
              input: { ...baseTaskInput, id: boundTaskId, threadId: undefined },
              existingTask: boundExistingTask,
            }),
          ))._tag,
        ).toBe("Failure");
        // Explicit unbind on locked thread -> must also fail for modo.
        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: modoSession.sessionId,
              input: { ...baseTaskInput, id: boundTaskId, threadId: null, unbindThread: true },
              existingTask: boundExistingTask,
            }),
          ))._tag,
        ).toBe("Failure");
        // Non-runNow mutations (setEnabled/delete/rotate) & webhook logs must fail for modo.
        expect(
          (yield* Effect.exit(
            team.assertCanMutateScheduledTask(modoSession.sessionId, boundTaskId, boundThreadId),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertCanReadScheduledTaskWebhooks(
              modoSession.sessionId,
              boundTaskId,
              boundThreadId,
            ),
          ))._tag,
        ).toBe("Failure");
        const modoBoundList = yield* team.filterReadableScheduledTasks(modoSession.sessionId, [
          boundExistingTask,
        ]);
        expect(modoBoundList[0]?.webhook).toBeUndefined();
        // Owner can still edit/mutate the locked-thread task.
        yield* team.assertCanMutateScheduledTask(
          ownerSession.sessionId,
          boundTaskId,
          boundThreadId,
        );

        // Spoofing teamMeta.environmentId to bypass host environment ACLs is rejected.
        const remoteEnvId = EnvironmentId.make("env-m8-remote");
        yield* team.attachEnvironment({
          sessionId: ownerSession.sessionId,
          payload: {
            environmentId: remoteEnvId,
            name: "Remote Modo Env",
            accessRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const ownerState = yield* team.getState(ownerSession.sessionId);
        const hostEnvRecord = (ownerState.environments ?? []).find(
          (env) => env.environmentId !== remoteEnvId,
        );
        expect(hostEnvRecord).toBeDefined();
        yield* team.updateEnvironment({
          sessionId: ownerSession.sessionId,
          payload: {
            environmentId: hostEnvRecord!.environmentId,
            accessRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        expect(
          (yield* Effect.exit(
            team.authorizeScheduledTaskUpsert({
              sessionId: modoSession.sessionId,
              input: { ...baseTaskInput, teamMeta: { environmentId: remoteEnvId } },
              existingTask: null,
            }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(team.assertCanMutateScheduledTask(modoSession.sessionId, minTaskId)))
            ._tag,
        ).toBe("Failure");

        // Child threads spawned from a locked scheduled-task thread inherit `locked: true`.
        const lockedParentThreadId = ThreadId.make("thread-m8-locked-parent");
        yield* team.prepareTeamAutomationThreadAttribution({
          taskId: elevTaskId,
          threadId: lockedParentThreadId,
          projectId,
        });
        const lockedChildThreadId = ThreadId.make("thread-m8-locked-child");
        const childPrincipal = {
          taskId: elevTaskId,
          teamId: init.team.id,
          projectId,
          environmentId: hostEnvRecord!.environmentId,
          viewId: init.team.defaultViewId,
          mcpAccessLevel: "elevated" as const,
        };
        yield* team.prepareThreadInheritedFromParent({
          parentThreadId: lockedParentThreadId,
          threadId: lockedChildThreadId,
          teamAutomation: childPrincipal,
        });
        const lockedChildAttr = Option.getOrThrow(
          yield* repo.getThreadAttribution(lockedChildThreadId),
        );
        expect(lockedChildAttr.ownerKind).toBe("team");
        expect(lockedChildAttr.locked).toBe(true);

        // Rollback removes thread_meta, turn_meta, and automation_turn_scopes cleanly.
        const rollbackThreadId = ThreadId.make("thread-m8-rollback");
        yield* team.prepareTeamAutomationThreadAttribution({
          taskId: minTaskId,
          threadId: rollbackThreadId,
          projectId,
        });
        yield* team.recordTeamAutomationTurn({
          threadId: rollbackThreadId,
          turnId: "msg:rollback-1",
          taskId: minTaskId,
          projectId,
        });
        yield* team.rollbackPreparedThreadAttribution(rollbackThreadId);
        expect(Option.isNone(yield* repo.getThreadAttribution(rollbackThreadId))).toBe(true);
        expect(Option.isNone(yield* repo.getTurnAttribution("msg:rollback-1"))).toBe(true);
        expect(Option.isNone(yield* repo.getAutomationTurnScope("msg:rollback-1"))).toBe(true);

        yield* team.recordTeamAutomationTurn({
          threadId: autoThreadId,
          turnId: "msg:bound-fail-1",
          taskId: elevTaskId,
          projectId,
        });
        yield* team.rollbackRecordedTurnAttribution({
          threadId: autoThreadId,
          turnId: "msg:bound-fail-1",
        });
        expect(Option.isNone(yield* repo.getTurnAttribution("msg:bound-fail-1"))).toBe(true);
        expect(Option.isNone(yield* repo.getAutomationTurnScope("msg:bound-fail-1"))).toBe(true);

        // Minimal automation is rejected on unattributed threads & wrong projectId task reads.
        const minimalActor: TeamService.TeamActor = {
          kind: "team_automation",
          principal: {
            taskId: minTaskId,
            teamId: init.team.id,
            projectId,
            environmentId: hostEnvRecord!.environmentId,
            viewId: init.team.defaultViewId,
            mcpAccessLevel: "minimal",
          },
        };
        const unattributedThreadId = ThreadId.make("thread-m8-unattributed");
        expect(
          (yield* Effect.exit(
            team.assertActorCanPromoteQueuedRun(minimalActor, unattributedThreadId),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertActorCanInterruptThread(minimalActor, unattributedThreadId),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertActorCanManageQueuedRun(minimalActor, unattributedThreadId, "run-x"),
          ))._tag,
        ).toBe("Failure");
        yield* team.assertActorCanReadScheduledTask(minimalActor, minTaskId, null, projectId);
        expect(
          (yield* Effect.exit(
            team.assertActorCanReadScheduledTask(
              minimalActor,
              minTaskId,
              null,
              ProjectId.make("proj-other"),
            ),
          ))._tag,
        ).toBe("Failure");

        // No cross-turn scope fallback: if a turn in team_turn_meta lacks its own scope row on a
        // thread previously used by an elevated task, resolveTurnPrincipal MUST fail closed (None).
        yield* team.requireTeamAutomationTurn({
          threadId: lockedParentThreadId,
          turnId: "run-elev-prev",
          taskId: elevTaskId,
          projectId,
        });
        yield* repo.recordTurnAttribution({
          turnId: "run-missing-scope",
          threadId: lockedParentThreadId,
          authorKind: "team_automation",
          authorMemberId: null,
          createdAt: "2026-01-02T00:00:00.000Z",
        });
        expect(
          Option.isNone(
            yield* team.resolveTurnPrincipal({
              threadId: lockedParentThreadId,
              runId: "run-missing-scope",
            }),
          ),
        ).toBe(true);

        // Cross-task locked thread boundary: minimal taskA CANNOT post into another task's locked
        // team-owned thread in the same (project, env, view), while owning minimal task CAN post
        // into its own locked thread and interrupt/manage its own automation runs.
        const sql = yield* SqlClient.SqlClient;
        const nowIso = "2026-01-02T00:00:00.000Z";
        const lockedOwnedMinTaskId = ScheduledTaskId.make("task-m8-locked-min-owned");
        yield* team.saveScheduledTaskMeta({
          taskId: lockedOwnedMinTaskId,
          teamId: init.team.id,
          environmentId: hostEnvRecord!.environmentId,
          viewId: init.team.defaultViewId,
          locked: true,
          mcpAccessLevel: "minimal",
          actorMemberId: init.owner.id,
        });
        const lockedOwnedMinThreadId = ThreadId.make("thread-m8-locked-min-owned");
        const lockedOwnedMinChildId = ThreadId.make("thread-m8-locked-min-child");
        for (const tid of [lockedParentThreadId, lockedOwnedMinThreadId, lockedOwnedMinChildId]) {
          yield* sql`
            INSERT OR IGNORE INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
            ) VALUES (
              ${tid}, ${projectId}, ${tid}, 'devReplay', 'full-access', 'default',
              NULL, ${nowIso}, ${nowIso}, NULL, NULL, '{}'
            )
          `;
        }
        yield* team.prepareTeamAutomationThreadAttribution({
          taskId: lockedOwnedMinTaskId,
          threadId: lockedOwnedMinThreadId,
          projectId,
        });
        const ownedMinPrincipal = {
          taskId: lockedOwnedMinTaskId,
          teamId: init.team.id,
          projectId,
          environmentId: hostEnvRecord!.environmentId,
          viewId: init.team.defaultViewId,
          mcpAccessLevel: "minimal" as const,
        };
        const ownedMinActor: TeamService.TeamActor = {
          kind: "team_automation",
          principal: ownedMinPrincipal,
        };
        // Minimal actor for `minTaskId` CANNOT post into locked `elevTaskId` thread OR locked `lockedOwnedMinTaskId` thread.
        expect(
          (yield* Effect.exit(team.assertActorCanPostInThread(minimalActor, lockedParentThreadId)))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertActorCanPostInThread(minimalActor, lockedOwnedMinThreadId),
          ))._tag,
        ).toBe("Failure");
        // Owning minimal task CAN post into its own locked thread AND idle locked child thread.
        yield* team.assertActorCanPostInThread(ownedMinActor, lockedOwnedMinThreadId);
        yield* team.prepareThreadInheritedFromParent({
          parentThreadId: lockedOwnedMinThreadId,
          threadId: lockedOwnedMinChildId,
          teamAutomation: ownedMinPrincipal,
        });
        yield* team.assertActorCanPostInThread(ownedMinActor, lockedOwnedMinChildId);
        // Minimal task CAN interrupt/manage its own automation runs, NOT another task's runs.
        yield* sql`
          INSERT OR IGNORE INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id,
            status, requested_at, completed_at, payload_json
          ) VALUES (
            'run-owned-min-active', ${lockedOwnedMinChildId}, 1, 'devReplay', NULL,
            'running', ${nowIso}, NULL, '{"userMessageId":"msg-owned-min-1"}'
          )
        `;
        yield* team.requireTeamAutomationTurn({
          threadId: lockedOwnedMinChildId,
          turnId: "run-owned-min-active",
          principal: ownedMinPrincipal,
        });
        yield* team.assertActorCanInterruptThread(
          ownedMinActor,
          lockedOwnedMinChildId,
          "run-owned-min-active",
        );
        yield* team.assertActorCanManageQueuedRun(
          ownedMinActor,
          lockedOwnedMinChildId,
          "run-owned-min-active",
        );
        expect(
          (yield* Effect.exit(
            team.assertActorCanInterruptThread(
              minimalActor,
              lockedOwnedMinChildId,
              "run-owned-min-active",
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            team.assertActorCanManageQueuedRun(
              minimalActor,
              lockedOwnedMinChildId,
              "run-owned-min-active",
            ),
          ))._tag,
        ).toBe("Failure");

        // Idle/waiting_for_children cancellation (runId = undefined): owning minimal task CAN stop
        // its own idle team-owned child thread, while another minimal task CANNOT.
        const idleChildThreadId = ThreadId.make("thread-m8-idle-min-child");
        yield* sql`
          INSERT OR IGNORE INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES (
            ${idleChildThreadId}, ${projectId}, ${idleChildThreadId}, 'devReplay', 'full-access', 'default',
            NULL, ${nowIso}, ${nowIso}, NULL, NULL, '{}'
          )
        `;
        yield* team.prepareThreadInheritedFromParent({
          parentThreadId: lockedOwnedMinThreadId,
          threadId: idleChildThreadId,
          teamAutomation: ownedMinPrincipal,
        });
        yield* team.assertActorCanInterruptThread(ownedMinActor, idleChildThreadId);
        expect(
          (yield* Effect.exit(team.assertActorCanInterruptThread(minimalActor, idleChildThreadId)))
            ._tag,
        ).toBe("Failure");

        // Stale historical automation scope on a later-locked member-owned thread CANNOT bypass the lock.
        const memberLaterLockedThreadId = ThreadId.make("thread-m8-member-later-locked");
        yield* sql`
          INSERT OR IGNORE INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES (
            ${memberLaterLockedThreadId}, ${projectId}, ${memberLaterLockedThreadId}, 'devReplay', 'full-access', 'default',
            NULL, ${nowIso}, ${nowIso}, NULL, NULL, '{}'
          )
        `;
        yield* team.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId: memberLaterLockedThreadId,
          viewId: init.team.defaultViewId,
        });
        yield* team.requireTeamAutomationTurn({
          threadId: memberLaterLockedThreadId,
          turnId: "run-hist-min-1",
          principal: ownedMinPrincipal,
        });
        yield* team.setThreadLocked({
          sessionId: ownerSession.sessionId,
          payload: { threadId: memberLaterLockedThreadId, locked: true },
        });
        expect(
          (yield* Effect.exit(
            team.assertActorCanPostInThread(ownedMinActor, memberLaterLockedThreadId),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  );

  it.effect(
    "supports leaving a team (blocking last active owner, revoking sessions/credentials) and deleting a team (owner-only with name confirmation)",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-owner" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme Engineering", ownerPseudo: "alice" },
        });

        // Sole active owner cannot leave the team before transferring ownership.
        const lastOwnerLeaveExit = yield* Effect.exit(
          team.leaveTeam({ sessionId: aliceSession.sessionId }),
        );
        expect(lastOwnerLeaveExit._tag).toBe("Failure");
        if (lastOwnerLeaveExit._tag === "Failure") {
          expect(Cause.squash(lastOwnerLeaveExit.cause)).toMatchObject({
            _tag: "TeamOperationError",
            code: "last_owner",
          });
        }

        // Invite Bob as regular member and Carol as second owner.
        const bobInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobJoined = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobSession = yield* sessions.verify(bobJoined.accessToken);

        const carolInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "owner", prefilledPseudo: "carol" },
        });
        const carolJoined = yield* team.redeemInvite({
          token: carolInvite.token,
          pseudo: "carol",
          client: testClient,
        });
        const carolSession = yield* sessions.verify(carolJoined.accessToken);

        // Create a custom view referencing Bob in memberIds to verify cleanup when Bob leaves.
        const customView = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Restricted",
            readRule: { roles: ["owner"], memberIds: [bobJoined.member.id] },
            postRule: { roles: ["owner"], memberIds: [bobJoined.member.id] },
          },
        });

        // Non-owner cannot delete the team.
        const bobDeleteExit = yield* Effect.exit(
          team.deleteTeam({
            sessionId: bobSession.sessionId,
            payload: { confirmTeamName: "Acme Engineering" },
          }),
        );
        expect(bobDeleteExit._tag).toBe("Failure");
        if (bobDeleteExit._tag === "Failure") {
          expect(Cause.squash(bobDeleteExit.cause)).toMatchObject({
            _tag: "TeamOperationError",
            code: "forbidden",
          });
        }

        // Subscribe Alice's stream BEFORE Bob leaves to verify live memberUpserted + viewUpserted broadcast.
        const bobLeaveEventsFiber = yield* team
          .streamState(aliceSession.sessionId)
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;

        // Bob leaves the team: his session is revoked, status becomes removed, and view memberIds cleaned up.
        const bobLeft = yield* team.leaveTeam({ sessionId: bobSession.sessionId });
        expect(bobLeft).toEqual({
          left: true,
          teamId: init.team.id,
          memberId: bobJoined.member.id,
        });
        const bobLeaveEvents = yield* Fiber.join(bobLeaveEventsFiber);
        expect(bobLeaveEvents.map((e) => e.type)).toEqual([
          "snapshot",
          "memberUpserted",
          "snapshot",
        ]);
        expect((yield* Effect.exit(sessions.verify(bobJoined.accessToken)))._tag).toBe("Failure");
        const stateAfterBobLeft = yield* team.getState(aliceSession.sessionId);
        expect(stateAfterBobLeft.members.find((m) => m.id === bobJoined.member.id)?.status).toBe(
          "removed",
        );
        const refreshedView = stateAfterBobLeft.views.find((v) => v.id === customView.id);
        expect(refreshedView?.readRule.memberIds).not.toContain(bobJoined.member.id);
        expect(refreshedView?.postRule.memberIds).not.toContain(bobJoined.member.id);

        // With Carol as a second active owner, Carol can leave while Alice remains owner.
        // Verify disconnect-driven revocation is armed BEFORE async peer cleanup so disconnecting
        // mid-cleanup revokes Carol's session immediately while cleanup still runs uninterruptibly.
        const carolDisconnected = yield* Deferred.make<void>();
        const carolPeerCleanupEntered = yield* Deferred.make<void>();
        const releaseCarolPeerCleanup = yield* Deferred.make<void>();
        const carolRevokedPeers: Array<EnvironmentId> = [];
        const carolLeaveFiber = yield* team
          .leaveTeam({
            sessionId: carolSession.sessionId,
            deferCallerSessionRevocation: {
              awaitDisconnect: Deferred.await(carolDisconnected),
              fallbackDelay: Duration.millis(500),
            },
            peerLinks: {
              list: Effect.succeed([{ environmentId: EnvironmentId.make("env-carol-peer") }]),
            } as never,
            peerClientPairing: {
              revokeSubject: (envId: EnvironmentId) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(carolPeerCleanupEntered, undefined);
                  yield* Deferred.await(releaseCarolPeerCleanup);
                  carolRevokedPeers.push(envId);
                  return { ok: true as const };
                }),
            } as never,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(carolPeerCleanupEntered);
        // Mid-cleanup: Carol is already marked removed, and her session is still valid until disconnect.
        const stateMidCarolLeave = yield* team.getState(aliceSession.sessionId);
        expect(stateMidCarolLeave.members.find((m) => m.id === carolJoined.member.id)?.status).toBe(
          "removed",
        );
        expect((yield* Effect.exit(sessions.verify(carolJoined.accessToken)))._tag).toBe("Success");
        // Disconnect mid-cleanup -> session revokes immediately even before peer cleanup unblocks.
        yield* Deferred.succeed(carolDisconnected, undefined);
        yield* TestClock.adjust(Duration.millis(1));
        expect((yield* Effect.exit(sessions.verify(carolJoined.accessToken)))._tag).toBe("Failure");
        yield* Deferred.succeed(releaseCarolPeerCleanup, undefined);
        const carolLeft = yield* Fiber.join(carolLeaveFiber);
        expect(carolLeft).toEqual({
          left: true,
          teamId: init.team.id,
          memberId: carolJoined.member.id,
        });
        expect(carolRevokedPeers).toEqual([EnvironmentId.make("env-carol-peer")]);

        // Invite Dana so we can verify deleteTeam revokes other active members' sessions & emits teamDeleted.
        const danaInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "admin", prefilledPseudo: "dana" },
        });
        const danaJoined = yield* team.redeemInvite({
          token: danaInvite.token,
          pseudo: "dana",
          client: testClient,
        });
        const danaSession = yield* sessions.verify(danaJoined.accessToken);

        // Mismatched confirmation name is rejected.
        const wrongNameExit = yield* Effect.exit(
          team.deleteTeam({
            sessionId: aliceSession.sessionId,
            payload: { confirmTeamName: "Wrong Name" },
          }),
        );
        expect(wrongNameExit._tag).toBe("Failure");
        if (wrongNameExit._tag === "Failure") {
          expect(Cause.squash(wrongNameExit.cause)).toMatchObject({
            _tag: "TeamOperationError",
            code: "invalid_input",
          });
        }

        // Record a team scheduled task and a server-hosted team provider to verify deleteTeam cleans up both.
        const teamTaskId = ScheduledTaskId.make("sched-team-delete-1");
        yield* team.saveScheduledTaskMeta({
          taskId: teamTaskId,
          teamId: init.team.id,
          environmentId: EnvironmentId.make("env-delete-1"),
          viewId: init.team.defaultViewId,
          actorMemberId: init.owner.id,
          mcpAccessLevel: "minimal",
          locked: false,
        });
        yield* team.upsertProvider({
          sessionId: aliceSession.sessionId,
          payload: {
            providerInstanceId: ProviderInstanceId.make("team-claude-del"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Team Claude",
            deliveryStrategy: "proxy",
            upstreamBaseUrl: "https://api.anthropic.com",
            apiKey: "sk-ant-test",
            enabled: true,
          },
        });
        // Reject virtual team: instance IDs via config.linkedServerInstanceId and conflicting clearSecret + link.
        const badConfigLinkExit = yield* Effect.exit(
          team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("team-bad-link"),
              driver: ProviderDriverKind.make("claudeAgent"),
              deliveryStrategy: "token-lease",
              config: { linkedServerInstanceId: `team:${init.team.id}:claude` },
              enabled: true,
            },
          }),
        );
        expect(badConfigLinkExit._tag).toBe("Failure");
        const conflictClearLinkExit = yield* Effect.exit(
          team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("team-bad-link"),
              driver: ProviderDriverKind.make("claudeAgent"),
              deliveryStrategy: "token-lease",
              clearSecret: true,
              sourceServerProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
            },
          }),
        );
        expect(conflictClearLinkExit._tag).toBe("Failure");

        const deletedTaskIds: Array<ScheduledTaskId> = [];
        const purgedWorkspaceCalls: Array<{
          readonly teamId: string;
          readonly count: number;
        }> = [];
        const fakeScheduledTaskService = {
          delete: ({ id }: { readonly id: ScheduledTaskId }) =>
            Effect.sync(() => {
              deletedTaskIds.push(id);
              return { deleted: true, id };
            }),
        } as never;
        const fakeProviderManager = {
          removeLocalTeamBinding: () => Effect.succeed(false),
          purgeTeamWorkspaceProfiles: (args: {
            readonly teamId: string;
            readonly providers: ReadonlyArray<unknown>;
          }) =>
            Effect.sync(() => {
              purgedWorkspaceCalls.push({ teamId: args.teamId, count: args.providers.length });
            }),
        } as never;

        // Departed member IDs must be rejected by attachEnvironment ACL validation, and
        // admin removal (updateMemberStatus -> removed) must also scrub existing view ACLs.
        const departedMemberAttachExit = yield* Effect.exit(
          team.attachEnvironment({
            sessionId: aliceSession.sessionId,
            payload: {
              environmentId: EnvironmentId.make("env-departed-acl-test"),
              name: "Departed ACL Runner",
              accessRule: { roles: ["owner"], memberIds: [bobJoined.member.id] },
            },
          }),
        );
        expect(departedMemberAttachExit._tag).toBe("Failure");
        if (departedMemberAttachExit._tag === "Failure") {
          expect(Cause.squash(departedMemberAttachExit.cause)).toMatchObject({
            _tag: "TeamOperationError",
            code: "invalid_input",
          });
        }
        const eveInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "eve" },
        });
        const eveJoined = yield* team.redeemInvite({
          token: eveInvite.token,
          pseudo: "eve",
          client: testClient,
        });
        const eveSession = yield* sessions.verify(eveJoined.accessToken);
        const eveEnvId = EnvironmentId.make("env-eve-acl-test");
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: eveEnvId,
            name: "Eve ACL Runner",
            accessRule: { roles: ["owner"], memberIds: [eveJoined.member.id] },
          },
        });
        yield* team.updateView({
          sessionId: aliceSession.sessionId,
          payload: {
            viewId: customView.id,
            readRule: { roles: ["owner"], memberIds: [eveJoined.member.id] },
            postRule: { roles: ["owner"], memberIds: [eveJoined.member.id] },
          },
        });
        // Subscribe both Alice (active) and Eve (removed) and use a distinct memberUpserted
        // sentinel (updateMyPseudo) to prove Alice gets one coalesced ACL snapshot and Eve
        // skips the redundant ACL snapshot refresh once marked inactive.
        const aliceInitialSeen = yield* Deferred.make<void>();
        const aliceRemovalSnapshotSeen = yield* Deferred.make<void>();
        let aliceEventCount = 0;
        const aliceRemovalEventsFiber = yield* team.streamState(aliceSession.sessionId).pipe(
          Stream.tap(() =>
            Effect.gen(function* () {
              aliceEventCount += 1;
              if (aliceEventCount === 1) {
                yield* Deferred.succeed(aliceInitialSeen, undefined);
              } else if (aliceEventCount === 3) {
                yield* Deferred.succeed(aliceRemovalSnapshotSeen, undefined);
              }
            }),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        const eveInitialSeen = yield* Deferred.make<void>();
        const eveRevokedSnapshotSeen = yield* Deferred.make<void>();
        let eveEventCount = 0;
        const eveRemovalEventsFiber = yield* team.streamState(eveSession.sessionId).pipe(
          Stream.tap(() =>
            Effect.gen(function* () {
              eveEventCount += 1;
              if (eveEventCount === 1) {
                yield* Deferred.succeed(eveInitialSeen, undefined);
              } else if (eveEventCount === 2) {
                yield* Deferred.succeed(eveRevokedSnapshotSeen, undefined);
              }
            }),
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(aliceInitialSeen);
        yield* Deferred.await(eveInitialSeen);
        yield* team.updateMemberStatus({
          sessionId: aliceSession.sessionId,
          payload: { memberId: eveJoined.member.id, status: "removed" },
        });
        yield* Deferred.await(aliceRemovalSnapshotSeen);
        yield* Deferred.await(eveRevokedSnapshotSeen);
        yield* team.updateMyPseudo({
          sessionId: aliceSession.sessionId,
          payload: { pseudo: "alice-sentinel" },
        });
        const aliceRemovalEvents = yield* Fiber.join(aliceRemovalEventsFiber);
        expect(aliceRemovalEvents.map((e) => e.type)).toEqual([
          "snapshot",
          "memberUpserted",
          "snapshot",
          "memberUpserted",
        ]);
        const streamedAfterEveRemoved = aliceRemovalEvents[2];
        expect(streamedAfterEveRemoved?.type).toBe("snapshot");
        if (streamedAfterEveRemoved?.type === "snapshot") {
          const streamedView = streamedAfterEveRemoved.payload.views.find(
            (v) => v.id === customView.id,
          );
          const streamedEnv = streamedAfterEveRemoved.payload.environments?.find(
            (e) => e.environmentId === eveEnvId,
          );
          expect(streamedEnv).toBeDefined();
          expect(streamedView?.readRule.memberIds).not.toContain(eveJoined.member.id);
          expect(streamedView?.postRule.memberIds).not.toContain(eveJoined.member.id);
          expect(streamedEnv?.accessRule.memberIds).not.toContain(eveJoined.member.id);
        }
        const aliceSentinel = aliceRemovalEvents[3];
        expect(aliceSentinel?.type).toBe("memberUpserted");
        if (aliceSentinel?.type === "memberUpserted") {
          expect(aliceSentinel.payload.pseudo).toBe("alice-sentinel");
        }
        const eveRemovalEvents = yield* Fiber.join(eveRemovalEventsFiber);
        expect(eveRemovalEvents.map((e) => e.type)).toEqual([
          "snapshot",
          "snapshot",
          "memberUpserted",
        ]);
        const eveSentinel = eveRemovalEvents[2];
        expect(eveSentinel?.type).toBe("memberUpserted");
        if (eveSentinel?.type === "memberUpserted") {
          expect(eveSentinel.payload.pseudo).toBe("alice-sentinel");
        }
        const stateAfterEveRemoved = yield* team.getState(aliceSession.sessionId);
        const viewAfterEveRemoved = stateAfterEveRemoved.views.find((v) => v.id === customView.id);
        const envAfterEveRemoved = stateAfterEveRemoved.environments?.find(
          (e) => e.environmentId === eveEnvId,
        );
        expect(viewAfterEveRemoved?.readRule.memberIds).not.toContain(eveJoined.member.id);
        expect(viewAfterEveRemoved?.postRule.memberIds).not.toContain(eveJoined.member.id);
        expect(envAfterEveRemoved?.accessRule.memberIds).not.toContain(eveJoined.member.id);
        yield* team.detachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: { environmentId: eveEnvId, unlinkPeer: false },
        });

        // Simulate an offline peer link during deleteTeam so we verify pending remote revocations
        // survive workspace deletion and still drain once the peer comes back online.
        const offlinePeerEnvId = EnvironmentId.make("env-offline-peer-1");
        let peerOnline = false;
        const revokedRemoteSubjects: Array<{
          readonly environmentId: EnvironmentId;
          readonly subjectPrefix: string;
        }> = [];
        const fakePeerClientPairing = {
          revokeSubject: (environmentId: EnvironmentId, subjectPrefix: string) =>
            Effect.sync(() => {
              if (!peerOnline) {
                return { ok: false as const, reason: "offline" as const };
              }
              revokedRemoteSubjects.push({ environmentId, subjectPrefix });
              return { ok: true as const };
            }),
        } as never;
        const fakePeerLinks = {
          list: Effect.succeed([{ environmentId: offlinePeerEnvId }]),
        } as never;

        // Fail closed when team scheduled tasks exist and scheduledTaskService is omitted.
        const missingSchedulerExit = yield* Effect.exit(
          team.deleteTeam({
            sessionId: aliceSession.sessionId,
            payload: { confirmTeamName: "Acme Engineering" },
          }),
        );
        expect(missingSchedulerExit._tag).toBe("Failure");

        // Fail closed when peerLinks.list fails during deleteTeam rather than skipping peer revocation.
        const peerDiscoveryFailExit = yield* Effect.exit(
          team.deleteTeam({
            sessionId: aliceSession.sessionId,
            payload: { confirmTeamName: "Acme Engineering" },
            scheduledTaskService: fakeScheduledTaskService,
            peerClientPairing: fakePeerClientPairing,
            peerLinks: {
              list: Effect.fail({ _tag: "PeerStoreUnavailableError" } as const),
            } as never,
          }),
        );
        expect(peerDiscoveryFailExit._tag).toBe("Failure");
        expect(deletedTaskIds).toEqual([]);
        // Verify team still exists after peer discovery failure.
        expect((yield* team.getState(aliceSession.sessionId)).team?.id).toBe(init.team.id);

        // Subscribe Alice's stream to verify `teamDeleted` event broadcast.
        const aliceStreamFiber = yield* team
          .streamState(aliceSession.sessionId)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;

        const deleted = yield* team.deleteTeam({
          sessionId: aliceSession.sessionId,
          payload: { confirmTeamName: "Acme Engineering" },
          peerClientPairing: fakePeerClientPairing,
          peerLinks: fakePeerLinks,
          scheduledTaskService: fakeScheduledTaskService,
          teamProviderManager: fakeProviderManager,
        });
        expect(deleted).toEqual({ deleted: true, teamId: init.team.id });
        expect(deletedTaskIds).toEqual([teamTaskId]);
        expect(purgedWorkspaceCalls).toEqual([{ teamId: init.team.id, count: 1 }]);
        expect(revokedRemoteSubjects).toEqual([]);

        const aliceEvents = yield* Fiber.join(aliceStreamFiber);
        expect(aliceEvents.map((e) => e.type)).toEqual(["snapshot", "teamDeleted"]);

        // Other members' sessions are revoked; team is now unconfigured.
        expect((yield* Effect.exit(sessions.verify(danaJoined.accessToken)))._tag).toBe("Failure");
        const emptyState = yield* team.getState(aliceSession.sessionId);
        expect(emptyState.team).toBeNull();
        expect(emptyState.members).toEqual([]);
        expect(emptyState.views).toEqual([]);

        // Once the offline peer reconnects in personal mode, pending revocation still drains.
        peerOnline = true;
        yield* team.drainPendingRemoteRevocations({
          peerClientPairing: fakePeerClientPairing,
          peerLinks: fakePeerLinks,
        });
        expect(revokedRemoteSubjects).toEqual([
          {
            environmentId: offlinePeerEnvId,
            subjectPrefix: `team-member:${init.team.id}:`,
          },
        ]);

        // Dana's session ID was revoked (unused variable silence check).
        expect(danaSession.sessionId).toBeTruthy();

        // Verify initializeTeam serializes against in-flight personal-mode remote pairing so a
        // workspace cannot be initialized mid-pairing under withRemotePairingPermit.
        const pairingEntered = yield* Deferred.make<void>();
        const releasePairing = yield* Deferred.make<void>();
        const raceEnvId = EnvironmentId.make("env-race-peer-1");
        let sawWorkspaceDuringPairing = false;
        const racePeerClientPairing = {
          revokeSubject: () => Effect.succeed({ ok: true as const }),
          request: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(pairingEntered, undefined);
              yield* Deferred.await(releasePairing);
              const wsNow = yield* team.getState(aliceSession.sessionId);
              sawWorkspaceDuringPairing = wsNow.team !== null;
              return { type: "credential" as const };
            }),
        } as never;
        const pairingFiber = yield* team
          .pairRemoteEnvironmentForSession({
            sessionId: aliceSession.sessionId,
            scopes: AuthStandardClientScopes,
            pairingInput: { environmentId: raceEnvId } as never,
            peerClientPairing: racePeerClientPairing,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(pairingEntered);
        // Attempt to initialize a replacement team while personal-mode pairing holds the permit;
        // initializeTeam must wait for the remote revocation barrier until pairing finishes.
        const replacementInitFiber = yield* team
          .initializeTeam({
            sessionId: aliceSession.sessionId,
            payload: { name: "Replacement Team", ownerPseudo: "alice" },
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(10));
        expect((yield* team.getState(aliceSession.sessionId)).team).toBeNull();
        yield* Deferred.succeed(releasePairing, undefined);
        const pairingResult = yield* Fiber.join(pairingFiber);
        expect(pairingResult).toEqual({ type: "credential" });
        expect(sawWorkspaceDuringPairing).toBe(false);
        const replacementInit = yield* Fiber.join(replacementInitFiber);
        expect(replacementInit.team.name).toBe("Replacement Team");
      }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  );
});
