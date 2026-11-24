import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, ThreadId, type AuthClientMetadata } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

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
  return Layer.mergeAll(teamService, teamRepo, sessions);
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

      // Recording thread/turn attribution in personal mode is a safe no-op.
      const threadId = ThreadId.make("thread-personal-1");
      yield* team.recordThreadCreated({ sessionId, threadId });
      yield* team.recordTurnAuthored({ sessionId, threadId, turnId: "turn-1" });
      expect(Option.isNone(yield* repo.getThreadAttribution(threadId))).toBe(true);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "initializes team, enforces modo+ invite role ceiling, unique pseudos, and server-authoritative attribution",
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

        // Second initialization fails.
        const duplicateInit = yield* Effect.exit(
          team.initializeTeam({
            sessionId: ownerSession.sessionId,
            payload: { name: "Other", ownerPseudo: "Other" },
          }),
        );
        expect(duplicateInit._tag).toBe("Failure");

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

        // Revoking an invite prevents redemption.
        const revokeResult = yield* team.revokeInvite({
          sessionId: charlieVerified.sessionId,
          payload: { inviteId: charlieModoInvite.invite.id },
        });
        expect(revokeResult.revoked).toBe(true);
        const revokedRedeem = yield* Effect.exit(
          team.redeemInvite({
            token: charlieModoInvite.token,
            pseudo: "dave",
            client: testClient,
          }),
        );
        expect(revokedRedeem._tag).toBe("Failure");

        // Server-authoritative thread & turn attribution from session bindings.
        const aliceThreadId = ThreadId.make("thread-alice-1");
        const bobThreadId = ThreadId.make("thread-bob-1");
        yield* team.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId: aliceThreadId,
        });
        yield* team.recordTurnAuthored({
          sessionId: ownerSession.sessionId,
          threadId: aliceThreadId,
          turnId: "run-1",
        });
        yield* team.recordTurnAuthored({
          sessionId: bobVerified.sessionId,
          threadId: aliceThreadId,
          turnId: "run-2",
        });
        yield* team.recordThreadCreated({
          sessionId: bobVerified.sessionId,
          threadId: bobThreadId,
        });

        const aliceAttr = Option.getOrThrow(yield* repo.getThreadAttribution(aliceThreadId));
        expect(aliceAttr.creatorMemberId).toBe(init.owner.id);
        expect(aliceAttr.creatorPseudo).toBe("Alice");

        const turns = yield* repo.listTurnAttributionsForThread(aliceThreadId);
        expect(turns.map((turn) => [turn.turnId, turn.authorMemberId, turn.authorPseudo])).toEqual([
          ["run-1", init.owner.id, "Alice"],
          ["run-2", bobRedeemed.member.id, "bob"],
        ]);

        // Updating Bob's pseudo updates attribution dynamically without mutating thread titles.
        const renamedBob = yield* team.updateMyPseudo({
          sessionId: bobVerified.sessionId,
          payload: { pseudo: "bob_dev" },
        });
        expect(renamedBob.pseudo).toBe("bob_dev");
        const bobAttrAfter = Option.getOrThrow(yield* repo.getThreadAttribution(bobThreadId));
        expect(bobAttrAfter.creatorPseudo).toBe("bob_dev");
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
