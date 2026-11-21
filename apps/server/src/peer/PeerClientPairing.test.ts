import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayConfigureScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type ExecutionEnvironmentDescriptor,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import { Toolkit } from "effect/ai";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerClientPairing from "./PeerClientPairing.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerEnvironmentAuth,
  layerLinkingEnvironment,
  linkTo,
  type ServedPeer,
  servePeer,
} from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", { linkClientPairing: true });
const NoTools = Toolkit.make();

const serveBox = (descriptor: ExecutionEnvironmentDescriptor = box) =>
  servePeer(
    descriptor,
    McpHttpServer.toolkitRegistration(NoTools, McpToolAccess.toLayer(NoTools, {})),
  );

/** The laptop: its links, its own clients, and what answers a client asking to pair with a link. */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* Layer.build(layerLinkingEnvironment(laptop));
  const authContext = yield* Layer.build(layerEnvironmentAuth("t3-peer-link-here-auth-"));
  const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
  const pairing = yield* PeerClientPairing.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
    Layer.provide(FetchHttpClient.layer),
    Layer.build,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
    pairing: Context.get(pairing, PeerClientPairing.PeerClientPairing),
    /** A client paired with the laptop, such as a phone. */
    client: (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      auth.issueSession({ scopes, label: "Phone" }),
  };
});

const metadata = { deviceType: "mobile" as const };

/** Asks the box's route directly, as anything holding `bearer` could, and answers its status. */
const askBox = (b: ServedPeer, bearer: string | undefined, headers: Record<string, string> = {}) =>
  HttpClient.execute(
    HttpClientRequest.post(`${b.url}/api/peer-link/client-pairing`).pipe(
      HttpClientRequest.setHeaders({
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...headers,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(
          JSON.stringify({ scopes: AuthStandardClientScopes, clientLabel: "Phone" }),
          "application/json",
        ),
      ),
    ),
  ).pipe(
    Effect.map((response) => response.status),
    Effect.provide(FetchHttpClient.layer),
  );

const linkTokenOf = (a: Effect.Success<typeof makeLaptop>) =>
  a.links.resolve(box.environmentId).pipe(Effect.map((resolved) => resolved.token));

it.effect(
  "a full-access link gets a client one pairing, with no more than the client holds here",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox();
        const a = yield* makeLaptop;
        yield* linkTo(a.links, b, "full-access");
        // Holds less than a pairing code grants, and one scope no pairing code grants.
        const held = [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthAccessWriteScope,
          AuthRelayConfigureScope,
        ];
        const phone = yield* a.client(held);

        const result = yield* a.pairing.request({ environmentId: box.environmentId }, phone);
        if (result.type !== "credential") return yield* Effect.die(result);
        expect(result).toMatchObject({
          environmentId: box.environmentId,
          label: "Box",
          urls: [b.url],
        });
        // The box's Connections says where the pairing came from, and can revoke it.
        expect(yield* b.auth.listPairingLinks()).toMatchObject([{ label: "Phone · via Laptop" }]);

        const session = yield* b.auth.exchangeBootstrapCredentialForAccessToken(
          result.credential,
          undefined,
          metadata,
        );
        expect(new Set(session.scope.split(" "))).toEqual(
          new Set([
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthAccessWriteScope,
          ]),
        );
        expect(session.scope).not.toContain(AuthTerminalOperateScope);
        const again = yield* b.auth
          .exchangeBootstrapCredentialForAccessToken(result.credential, undefined, metadata)
          .pipe(Effect.flip);
        expect(again._tag).toBe("ServerAuthInvalidCredentialError");

        // One the client never redeems is gone within minutes.
        const unused = yield* a.pairing.request({ environmentId: box.environmentId }, phone);
        if (unused.type !== "credential") return yield* Effect.die(unused);
        yield* TestClock.adjust("3 minutes");
        const late = yield* b.auth
          .exchangeBootstrapCredentialForAccessToken(unused.credential, undefined, metadata)
          .pipe(Effect.flip);
        expect(late._tag).toBe("ServerAuthInvalidCredentialError");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each(["read-only", "approval-required", "auto"] as const)(
  "a %s link cannot pair a client, even when the linking environment is bypassed",
  (access: AuthMcpClientAccess) =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox();
        const a = yield* makeLaptop;
        yield* linkTo(a.links, b, access);
        const phone = yield* a.client(AuthStandardClientScopes);

        expect(yield* a.pairing.request({ environmentId: box.environmentId }, phone)).toEqual({
          type: "unsupported",
          reason: "link_access",
          environmentId: box.environmentId,
          label: "Box",
          urls: [b.url],
        });
        expect(yield* Ref.get(b.bearers)).toEqual([]);

        expect(yield* askBox(b, yield* linkTokenOf(a))).toBe(403);
        expect(yield* b.auth.listPairingLinks()).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("only a full-access link's own session reaches the box's pairing route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const linkToken = yield* linkTokenOf(a);

      // An outside agent approved at full access is not a link.
      const agent = yield* b.auth.issueMcpClientSession({
        label: "Outside agent",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      expect(yield* askBox(b, agent.token)).toBe(403);

      // An agent's thread credential, which a link-started agent holds too, is not a session.
      const registry = yield* McpSessionRegistry.layer.pipe(
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(box.environmentId),
            getDescriptor: Effect.succeed(box),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
        Layer.build,
      );
      const thread = yield* Context.get(registry, McpSessionRegistry.McpSessionRegistry).issue({
        threadId: ThreadId.make("thread:box-link-started"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(yield* askBox(b, thread.config.authorizationHeader.slice("Bearer ".length))).toBe(401);

      // The box's own administrator client pairs devices from Connections, not from here.
      const owner = yield* b.auth.issueSession({ scopes: AuthStandardClientScopes });
      expect(yield* askBox(b, owner.token)).toBe(401);
      expect(yield* askBox(b, undefined)).toBe(401);
      // A page in a browser never holds a link's token.
      expect(yield* askBox(b, linkToken, { origin: "https://example.com" })).toBe(403);
      expect(yield* b.auth.listPairingLinks()).toEqual([]);

      expect(yield* askBox(b, linkToken)).toBe(200);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("pairs no client while Linked environments is off on either side", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const phone = yield* a.client(AuthStandardClientScopes);
      const linkToken = yield* linkTokenOf(a);

      yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      expect(yield* askBox(b, linkToken)).toBe(403);
      expect(yield* a.pairing.request({ environmentId: box.environmentId }, phone)).toMatchObject({
        type: "unsupported",
        reason: "refused",
      });
      yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: true });

      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      const off = yield* a.pairing
        .request({ environmentId: box.environmentId }, phone)
        .pipe(Effect.flip);
      expect(off.reason).toBe("disabled");
      expect(yield* b.auth.listPairingLinks()).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a linked environment from before client pairing is never asked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox(descriptorOf("environment-box", "Box"));
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const phone = yield* a.client(AuthStandardClientScopes);

      expect(yield* a.pairing.request({ environmentId: box.environmentId }, phone)).toEqual({
        type: "unsupported",
        reason: "version",
        environmentId: box.environmentId,
        label: "Box",
        urls: [b.url],
      });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
