import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentHttpApi } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";
import * as TeamHttp from "./http.ts";

class TeamTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.team) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const makeTeamHttpFixture = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-http-test-" }).pipe(
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
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(sessions),
    Layer.provide(base),
  );
  return Layer.mergeAll(teamService, secretStore, platform);
};

describe("TeamHttp", () => {
  it.live("previews invites, enforces DPoP replay protection, and maps error statuses", () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const teamService = yield* TeamService.TeamService;
      const ownerSessionId = AuthSessionId.make("owner-http-session-1");

      yield* teamService.initializeTeam({
        sessionId: ownerSessionId,
        payload: {
          name: "HTTP Team",
          ownerPseudo: "alice",
        },
      });
      const multiUseInvite = yield* teamService.createInvite({
        sessionId: ownerSessionId,
        payload: {
          role: "regular",
          maxUses: 3,
        },
      });
      const revokedInvite = yield* teamService.createInvite({
        sessionId: ownerSessionId,
        payload: {
          role: "regular",
          maxUses: 1,
        },
      });
      yield* teamService.revokeInvite({
        sessionId: ownerSessionId,
        payload: { inviteId: revokedInvite.invite.id },
      });

      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const httpLayer = HttpApiBuilder.layer(TeamTestApi).pipe(
        Layer.provide(TeamHttp.layer),
        Layer.provide(Layer.succeed(TeamService.TeamService, teamService)),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      const redeemUrl = "http://127.0.0.1/api/team/invites/redeem";
      const dpopKey = makeDpopKey();

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(httpLayer, { disableLogger: true })),
        (web) =>
          Effect.promise(async () => {
            const unknownPreview = await web.handler(
              postJson("/api/team/invites/preview", { token: "t3team_unknown" }),
              requestContext,
            );
            expect(unknownPreview.status).toBe(400);
            expect(await unknownPreview.json()).toMatchObject({ code: "invite_invalid" });

            const validPreview = await web.handler(
              postJson("/api/team/invites/preview", { token: multiUseInvite.token }),
              requestContext,
            );
            expect(validPreview.status).toBe(200);
            expect(await validPreview.json()).toMatchObject({
              teamName: "HTTP Team",
              role: "regular",
            });

            const revokedPreview = await web.handler(
              postJson("/api/team/invites/preview", { token: revokedInvite.token }),
              requestContext,
            );
            expect(revokedPreview.status).toBe(409);
            expect(await revokedPreview.json()).toMatchObject({ code: "invite_revoked" });

            const bearerRedeem = await web.handler(
              postJson("/api/team/invites/redeem", {
                token: multiUseInvite.token,
                pseudo: "bob",
              }),
              requestContext,
            );
            expect(bearerRedeem.status).toBe(200);
            expect(bearerRedeem.headers.get("cache-control")).toBe("no-store");
            expect(bearerRedeem.headers.get("pragma")).toBe("no-cache");
            expect(await bearerRedeem.json()).toMatchObject({
              tokenType: "Bearer",
              member: { pseudo: "bob", role: "regular" },
            });

            const duplicatePseudo = await web.handler(
              postJson("/api/team/invites/redeem", {
                token: multiUseInvite.token,
                pseudo: "bob",
              }),
              requestContext,
            );
            expect(duplicatePseudo.status).toBe(409);
            expect(await duplicatePseudo.json()).toMatchObject({ code: "pseudo_taken" });

            const badDpop = await web.handler(
              postJson(
                "/api/team/invites/redeem",
                { token: multiUseInvite.token, pseudo: "carol" },
                { dpop: "not-a-dpop-proof" },
              ),
              requestContext,
            );
            expect(badDpop.status).toBe(400);
            expect(await badDpop.json()).toMatchObject({ code: "invite_invalid" });

            const dpopProof = dpopKey.sign({ method: "POST", url: redeemUrl, token: "", iat });
            const dpopRedeem = await web.handler(
              postJson(
                "/api/team/invites/redeem",
                { token: multiUseInvite.token, pseudo: "carol" },
                { dpop: dpopProof },
              ),
              requestContext,
            );
            expect(dpopRedeem.status).toBe(200);
            expect(await dpopRedeem.json()).toMatchObject({
              tokenType: "DPoP",
              member: { pseudo: "carol", role: "regular" },
            });

            const replayedDpop = await web.handler(
              postJson(
                "/api/team/invites/redeem",
                { token: multiUseInvite.token, pseudo: "dave" },
                { dpop: dpopProof },
              ),
              requestContext,
            );
            expect(replayedDpop.status).toBe(400);
            expect(await replayedDpop.json()).toMatchObject({
              code: "invite_invalid",
              message: "DPoP proof has already been used.",
            });
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(makeTeamHttpFixture())),
  );
});
