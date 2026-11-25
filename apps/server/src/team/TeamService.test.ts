import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthRelayWriteScope,
  AuthSessionId,
  MessageId,
  RunId,
  ThreadId,
  type AuthClientMetadata,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type TeamStateStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
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
        invites: [],
        threadAttributions: [],
        followedThreadIds: [],
        latestTurnAttributions: [],
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
        const suspendedEvents = yield* Fiber.join(suspendedFiber);
        expect(suspendedEvents.map((event) => event.type)).toEqual([
          "snapshot",
          "threadAttributed",
        ]);
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
});
