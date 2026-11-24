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
});
