import { expect, it } from "@effect/vitest";
import type { HostApiRootAuthority } from "@t3tools/extension-runtime";
import { SessionStore } from "../auth/SessionStore.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  EnvironmentAuthenticatedPrincipal,
  ExtensionInvokeInput,
  ThreadId,
  PreviewTabId,
  type AuthEnvironmentScope,
  type ExtensionApiInvokeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeOperations } from "./http.ts";
import { EnvironmentExtensions } from "./EnvironmentExtensions.ts";
import type { ClientApiProviders } from "./ClientApiProviders.ts";

const unusedClientApiProviders = {
  connect: () => Effect.die("unused"),
  respond: () => Effect.die("unused"),
  emit: () => Effect.die("unused"),
  invoke: () => Effect.die("unused"),
  openSubscription: () => Effect.die("unused"),
  registerCorrelation: () => Effect.die("unused"),
  unregisterCorrelation: () => Effect.die("unused"),
  listTargets: () => Effect.die("unused"),
  resolveTarget: () => Effect.die("unused"),
  hasProvider: () => Effect.die("unused"),
  connectionForSession: () => Effect.die("unused"),
} satisfies ClientApiProviders["Service"];

const decodeInvocation = Schema.decodeUnknownEffect(ExtensionInvokeInput);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCatalogueMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ supportsCatalogueChanges: Schema.Boolean })),
);

function fixture(
  scopes: readonly AuthEnvironmentScope[],
  assetHooks?: { read: () => Uint8Array; revalidate: () => void },
) {
  const called: string[] = [];
  const roots: (HostApiRootAuthority | undefined)[] = [];
  const service = EnvironmentExtensions.of({
    catalogue: Effect.succeed({ apiSelections: [], apiResolution: [], pluginResolution: [] }),
    subscribeApi: () => Stream.empty,
    invokeApi: (_input: ExtensionApiInvokeInput, root?: HostApiRootAuthority) =>
      Effect.sync(() => {
        roots.push(root);
        called.push("invokeApi");
        return { ok: true };
      }),
    discoverApis: () =>
      Effect.sync(() => {
        called.push("discoverApis");
        return [];
      }),
    selectApi: () =>
      Effect.sync(() => {
        called.push("selectApi");
      }),
    list: Effect.sync(() => {
      called.push("list");
      return [];
    }),
    asset: () =>
      Effect.sync(() => {
        called.push("asset");
        return assetHooks?.read() ?? new Uint8Array([0, 97, 115, 109]);
      }),
    client: () =>
      Effect.sync(() => {
        called.push("client");
        return { code: "fixture", contentHash: "a".repeat(64) };
      }),
    invoke: () =>
      Effect.sync(() => {
        called.push("invoke");
        return { ok: true };
      }),
    install: () =>
      Effect.sync(() => {
        called.push("install");
        return {
          id: "fixture",
          contentHash: "a".repeat(64),
          package: {},
          enabled: true,
          grants: { capabilities: [], projectIds: [] },
        };
      }),
    manage: () =>
      Effect.sync(() => {
        called.push("manage");
        return null;
      }),
    contextForThread: () => Effect.die("unused"),
    tools: () => Effect.die("unused"),
    clientApiProviders: unusedClientApiProviders,
  });
  const operations = makeOperations(service, (session, scope, writeScope) =>
    Effect.succeed({
      principal: {
        kind: "environment-session" as const,
        id: session.sessionId,
        environmentId: "env-a",
        subject: session.subject,
        scopes: [...session.scopes],
      },
      allowWrite:
        writeScope === undefined ? scope === AuthAccessWriteScope : session.scopes.has(writeScope),
      revalidate: () => {
        assetHooks?.revalidate();
      },
    }),
  );
  const principal = {
    sessionId: AuthSessionId.make("fixture-session"),
    subject: "fixture",
    method: "bearer-access-token" as const,
    scopes: new Set(scopes),
  };
  const provide = <A, E>(effect: Effect.Effect<A, E, EnvironmentAuthenticatedPrincipal>) =>
    effect.pipe(Effect.provideService(EnvironmentAuthenticatedPrincipal, principal));
  return { called, roots, service, operations, provide };
}
it.effect("read credential can read but cannot install, update, enable or remove", () =>
  Effect.gen(function* () {
    const f = fixture([AuthOrchestrationReadScope]);
    expect(yield* f.provide(f.operations.list())).toEqual({
      installations: [],
      supportsCatalogueChanges: true,
      supportedPackageFormats: [1, 2, 3, 4],
      supportsApiStreams: true,
      apiSelections: [],
      apiResolution: [],
      pluginResolution: [],
    });
    yield* f.provide(f.operations.client({ id: "fixture", expectedContentHash: "a".repeat(64) }));
    expect(
      (yield* f.provide(
        Effect.flip(
          f.operations.install({
            sourceDir: "/fixture",
            trusted: true,
            projectIds: [],
            capabilities: [],
          }),
        ),
      ))._tag,
    ).toBe("EnvironmentScopeRequiredError");
    for (const action of ["enable", "disable", "remove", "update", "rollback", "grants"] as const)
      expect(
        (yield* f.provide(Effect.flip(f.operations.manage({ id: "fixture", action }))))._tag,
      ).toBe("EnvironmentScopeRequiredError");
    expect(f.called).toEqual(["list", "client"]);
  }),
);
it.effect("missing read scope cannot inspect code, catalog or invoke even with access-write", () =>
  Effect.gen(function* () {
    const f = fixture([AuthAccessWriteScope]);
    const input = yield* decodeInvocation({
      toolId: "fixture/read",
      input: {},
      expectedContentHash: "a".repeat(64),
      context: { resource: { namespace: "fixture", id: "a", environmentId: "env" }, client: "web" },
    });
    expect((yield* f.provide(Effect.flip(f.operations.list())))._tag).toBe(
      "EnvironmentScopeRequiredError",
    );
    expect(
      (yield* f.provide(
        Effect.flip(f.operations.client({ id: "fixture", expectedContentHash: "a".repeat(64) })),
      ))._tag,
    ).toBe("EnvironmentScopeRequiredError");
    expect((yield* f.provide(Effect.flip(f.operations.invoke(input))))._tag).toBe(
      "EnvironmentScopeRequiredError",
    );
    expect(f.called).toEqual([]);
    yield* f.provide(f.operations.manage({ id: "fixture", action: "disable" }));
    expect(f.called).toEqual(["manage"]);
  }),
);

it.effect(
  "selects invokeApi authority from verified domain scopes without widening old callers",
  () =>
    Effect.gen(function* () {
      const input: ExtensionApiInvokeInput = {
        installationId: "fixture",
        expectedContentHash: "a".repeat(64),
        request: {
          id: "t3.workspace/files",
          versionRange: "^1.0.0",
          method: "listEntries",
          input: { relativePath: "" },
          context: {
            resource: { namespace: "fixture", id: "a", environmentId: EnvironmentId.make("env") },
            client: "web",
          },
        },
      };
      const cases = [
        // Read-only pairing: invokeApi passes, root ceiling stays read-only so
        // the broker rejects write-effect methods.
        { scopes: [AuthOrchestrationReadScope] as const, allowWrite: false },
        // Ordinary paired session: domain operate makes the root write-capable
        // without any administrative access:write grant.
        {
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const,
          allowWrite: true,
        },
        // access:write is an administrative grant and never substitutes for the
        // domain operate scope.
        {
          scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope] as const,
          allowWrite: false,
        },
      ];
      for (const testCase of cases) {
        const f = fixture(testCase.scopes);
        yield* f.provide(f.operations.invokeApi(input));
        expect(f.roots).toHaveLength(1);
        expect(f.roots[0]?.allowWrite).toBe(testCase.allowWrite);
        expect(f.called).toEqual(["invokeApi"]);
      }
      const denied = fixture([]);
      expect((yield* denied.provide(Effect.flip(denied.operations.invokeApi(input))))._tag).toBe(
        "EnvironmentScopeRequiredError",
      );
      expect(denied.called).toEqual([]);
      expect(denied.roots).toEqual([]);
    }),
);

it.effect(
  "invokeApi requires a domain scope even with access:write; admin stays access:write-gated",
  () =>
    Effect.gen(function* () {
      const input: ExtensionApiInvokeInput = {
        installationId: "fixture",
        expectedContentHash: "a".repeat(64),
        request: {
          id: "t3.workspace/files",
          versionRange: "^1.0.0",
          method: "listEntries",
          input: { relativePath: "" },
          context: {
            resource: { namespace: "fixture", id: "a", environmentId: EnvironmentId.make("env") },
            client: "web",
          },
        },
      };
      // An access:write-only session cannot invoke APIs at all: it holds no
      // orchestration domain scope, and the administrative grant is not a
      // substitute.
      const adminOnly = fixture([AuthAccessWriteScope]);
      expect(
        (yield* adminOnly.provide(Effect.flip(adminOnly.operations.invokeApi(input))))._tag,
      ).toBe("EnvironmentScopeRequiredError");
      expect(adminOnly.called).toEqual([]);
      // Extension administration keeps its transport gate: a session with
      // orchestration:operate but no access:write is denied install/manage/select.
      const operator = fixture([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      expect(
        (yield* operator.provide(
          Effect.flip(
            operator.operations.install({
              sourceDir: "/fixture",
              trusted: true,
              projectIds: [],
              capabilities: [],
            }),
          ),
        ))._tag,
      ).toBe("EnvironmentScopeRequiredError");
      expect(
        (yield* operator.provide(
          Effect.flip(operator.operations.manage({ id: "fixture", action: "enable" })),
        ))._tag,
      ).toBe("EnvironmentScopeRequiredError");
      expect(
        (yield* operator.provide(
          Effect.flip(
            operator.operations.selectApi({
              id: "t3.workspace/files",
              providerId: "host.workspace",
              fallbackProviderIds: [],
            }),
          ),
        ))._tag,
      ).toBe("EnvironmentScopeRequiredError");
      expect(operator.called).toEqual([]);
    }),
);

// Exercise the actual middleware and HTTP schemas without opening a listening socket.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, AuthAdministrativeScopes } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BrowserFrameLeases from "../browserFrames/BrowserFrameLeases.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { extensionsHttpApiLayer } from "./http.ts";

class ExtensionTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.extensions,
) {}
const realAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "t3-extension-http-test-" })),
  Layer.provide(NodeServices.layer),
);
it.live(
  "actual HTTP authentication rejects anonymous and read-only writes before extension execution",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore;
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const f = fixture([]);
      const routes = HttpApiBuilder.layer(ExtensionTestApi).pipe(
        Layer.provide(extensionsHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
        Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
        Layer.provide(Layer.succeed(SessionStore, sessions)),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: environment.getEnvironmentId,
            getDescriptor: Effect.die("unused descriptor"),
          }),
        ),
        Layer.provide(Layer.succeed(EnvironmentExtensions, f.service)),
        Layer.provide(NodeHttpPlatform.layer),
        Layer.provide(Etag.layer),
        Layer.provide(NodeServices.layer),
      );
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (web) => Effect.promise(web.dispose),
      );
      const request = (endpoint: string, payload: unknown, token?: string) =>
        encodePayload(payload).pipe(
          Effect.flatMap((body) =>
            Effect.promise(() =>
              web.handler(
                new Request(`http://fixture/api/extensions/${endpoint}`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                  },
                  body,
                }),
              ),
            ),
          ),
        );
      const client = { id: "fixture", expectedContentHash: "a".repeat(64) };
      const invoke = {
        toolId: "fixture/read",
        input: {},
        expectedContentHash: "a".repeat(64),
        context: {
          resource: { namespace: "fixture", id: "a", environmentId: "env" },
          client: "web",
        },
      };
      const apiDiscover = {
        installationId: "fixture",
        expectedContentHash: "a".repeat(64),
        context: invoke.context,
      };
      const apiInvoke = {
        installationId: "fixture",
        expectedContentHash: "a".repeat(64),
        request: {
          id: "t3.workspace/files",
          versionRange: "^1.0.0",
          method: "listEntries",
          input: { relativePath: "" },
          context: invoke.context,
        },
      };
      const apiSelect = {
        id: "t3.workspace/files",
        providerId: "host.workspace",
        fallbackProviderIds: [],
      };
      for (const [endpoint, payload] of [
        ["list", {}],
        ["client", client],
        ["invoke", invoke],
        ["api/discover", apiDiscover],
        ["api/invoke", apiInvoke],
        ["api/select", apiSelect],
      ] as const)
        expect((yield* request(endpoint, payload)).status).toBe(401);
      expect(f.called).toEqual([]);
      const metadata = {
        deviceType: "desktop" as const,
        os: "Linux",
        browser: "fixture",
        ipAddress: "127.0.0.1",
      };
      const readGrant = yield* auth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope],
      });
      const read = yield* auth.exchangeBootstrapCredentialForAccessToken(
        readGrant.credential,
        undefined,
        metadata,
      );
      const listed = yield* request("list", {}, read.access_token);
      expect(listed.status).toBe(200);
      const listedBody = yield* Effect.promise(() => listed.text()).pipe(
        Effect.flatMap(decodeCatalogueMetadata),
      );
      expect(listedBody).toMatchObject({ supportsCatalogueChanges: true });
      expect((yield* request("client", client, read.access_token)).status).toBe(200);
      expect((yield* request("invoke", invoke, read.access_token)).status).toBe(200);
      expect(
        (yield* request(
          "install",
          { sourceDir: "/fixture", trusted: true, projectIds: [], capabilities: [] },
          read.access_token,
        )).status,
      ).toBe(403);
      for (const action of ["enable", "disable", "remove", "update", "rollback", "grants"])
        expect(
          (yield* request("manage", { id: "fixture", action }, read.access_token)).status,
        ).toBe(403);
      expect((yield* request("api/discover", apiDiscover, read.access_token)).status).toBe(200);
      expect((yield* request("api/invoke", apiInvoke, read.access_token)).status).toBe(200);
      expect((yield* request("api/select", apiSelect, read.access_token)).status).toBe(403);
      expect(f.called).toEqual(["list", "client", "invoke", "discoverApis", "invokeApi"]);
      // An access:write-only (administrative) session keeps install/select
      // authority but holds no orchestration domain scope, so api/invoke is
      // denied outright.
      const writeGrant = yield* auth.issuePairingCredential({ scopes: [AuthAccessWriteScope] });
      const write = yield* auth.exchangeBootstrapCredentialForAccessToken(
        writeGrant.credential,
        undefined,
        metadata,
      );
      expect((yield* request("api/discover", apiDiscover, write.access_token)).status).toBe(403);
      expect((yield* request("api/invoke", apiInvoke, write.access_token)).status).toBe(403);
      expect((yield* request("api/select", apiSelect, write.access_token)).status).toBe(200);
      expect(f.called).toEqual([
        "list",
        "client",
        "invoke",
        "discoverApis",
        "invokeApi",
        "selectApi",
      ]);
      // The only root so far is the read-only pairing's: read ceiling intact.
      expect(f.roots).toHaveLength(1);
      expect(f.roots[0]?.principal.kind).toBe("environment-session");
      expect(f.roots[0]?.principal.environmentId).toBe(yield* environment.getEnvironmentId);
      expect(f.roots[0]?.principal.scopes).toContain(AuthOrchestrationReadScope);
      expect(f.roots[0]?.allowWrite).toBe(false);
      // read + access:write enters via the read scope but gets a read-only
      // root: the administrative grant is never a domain write authority.
      const bothGrant = yield* auth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope],
      });
      const both = yield* auth.exchangeBootstrapCredentialForAccessToken(
        bothGrant.credential,
        undefined,
        metadata,
      );
      expect((yield* request("api/invoke", apiInvoke, both.access_token)).status).toBe(200);
      expect(f.roots[1]?.principal.scopes).toContain(AuthAccessWriteScope);
      expect(f.roots[1]?.allowWrite).toBe(false);
      // Ordinary pairing (read + operate, no access:write) gets the
      // write-capable root the Files save path requires.
      const operateGrant = yield* auth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
      const operate = yield* auth.exchangeBootstrapCredentialForAccessToken(
        operateGrant.credential,
        undefined,
        metadata,
      );
      expect((yield* request("api/invoke", apiInvoke, operate.access_token)).status).toBe(200);
      expect(f.roots[2]?.principal.scopes).toContain(AuthOrchestrationOperateScope);
      expect(f.roots[2]?.allowWrite).toBe(true);
      const adminGrant = yield* auth.issuePairingCredential({ scopes: AuthAdministrativeScopes });
      const admin = yield* auth.exchangeBootstrapCredentialForAccessToken(
        adminGrant.credential,
        undefined,
        metadata,
      );
      expect(
        (yield* request("manage", { id: "fixture", action: "disable" }, admin.access_token)).status,
      ).toBe(200);
      expect(
        (yield* request(
          "install",
          { sourceDir: "/fixture", trusted: true, projectIds: [], capabilities: [] },
          admin.access_token,
        )).status,
      ).toBe(200);
      expect(f.called).toEqual([
        "list",
        "client",
        "invoke",
        "discoverApis",
        "invokeApi",
        "selectApi",
        "invokeApi",
        "invokeApi",
        "manage",
        "install",
      ]);
    }).pipe(Effect.provide(realAuthLayer)),
);
it.live("invokeApi binds the client's own live root connection via the echoed instance id", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const leases = yield* BrowserFrameLeases.BrowserFrameLeases;
    const f = fixture([]);
    const routes = HttpApiBuilder.layer(ExtensionTestApi).pipe(
      Layer.provide(extensionsHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
      Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provide(Layer.succeed(SessionStore, sessions)),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: environment.getEnvironmentId,
          getDescriptor: Effect.die("unused descriptor"),
        }),
      ),
      Layer.provide(Layer.succeed(EnvironmentExtensions, f.service)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layer),
      Layer.provide(NodeServices.layer),
    );
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) => Effect.promise(web.dispose),
    );
    const request = (
      endpoint: string,
      payload: unknown,
      token?: string,
      clientInstanceId?: string,
    ) =>
      encodePayload(payload).pipe(
        Effect.flatMap((body) =>
          Effect.promise(() =>
            web.handler(
              new Request(`http://fixture/api/extensions/${endpoint}`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(token ? { authorization: `Bearer ${token}` } : {}),
                  ...(clientInstanceId !== undefined
                    ? { "x-t3-client-instance": clientInstanceId }
                    : {}),
                },
                body,
              }),
            ),
          ),
        ),
      );
    const metadata = {
      deviceType: "desktop" as const,
      os: "Linux",
      browser: "fixture",
      ipAddress: "127.0.0.1",
    };
    const grant = yield* auth.issuePairingCredential({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    });
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      grant.credential,
      undefined,
      metadata,
    );
    const apiInvoke = {
      installationId: "fixture",
      expectedContentHash: "a".repeat(64),
      request: {
        id: "t3.workspace/files",
        versionRange: "^1.0.0",
        method: "listEntries",
        input: { relativePath: "" },
        context: {
          resource: { namespace: "fixture", id: "a", environmentId: "env" },
          client: "web",
        },
      },
    };
    const session = (yield* sessions.listActive())[0];
    expect(session).toBeDefined();
    // Two client instances share the session; each registered its own ws
    // connection on upgrade. B connects second — newest must not win.
    yield* sessions.markConnected(session!.sessionId, "conn-a", "inst-a");
    yield* sessions.markConnected(session!.sessionId, "conn-b", "inst-b");
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-a")).status).toBe(
      200,
    );
    expect(f.roots[0]?.connectionId).toBe("conn-a");
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-b")).status).toBe(
      200,
    );
    expect(f.roots[1]?.connectionId).toBe("conn-b");
    // A supplied instance id that resolves to nothing — never registered or
    // already disconnected — is a stale identity and fails by name rather
    // than downgrading to connectionless: its mints would escape root
    // connection revocation entirely. Only an absent header stays
    // connectionless (documented pure-HTTP mode).
    const staleUnknown = yield* request("api/invoke", apiInvoke, token.access_token, "inst-c");
    expect(staleUnknown.status).toBe(400);
    const staleBody = yield* Effect.promise(() => staleUnknown.json());
    expect(staleBody).toMatchObject({
      _tag: "ExtensionOperationError",
      detail: expect.stringContaining("ExtensionClientInstanceError"),
    });
    expect((yield* request("api/invoke", apiInvoke, token.access_token)).status).toBe(200);
    expect(f.roots[2]?.connectionId).toBeUndefined();
    // A record minted under instance A's authority dies with A's connection
    // while B's binding survives — attribution is per-connection, not
    // per-session-newest.
    const environmentId = yield* environment.getEnvironmentId;
    const mintA = (connId: string) =>
      leases.issueInputLease({
        authority: {
          kind: "extension",
          principalKind: "environment-session",
          principalId: f.roots[0]!.principal.id,
          rootCallerId: "fixture-ext",
          callerId: "fixture-ext",
          callerGenerations: [],
          rootConnectionId: connId,
          context: null,
          grants: [],
        },
        session: {
          environmentId,
          threadId: ThreadId.make("thread-a"),
          serverEpoch: "epoch-1",
          tabId: PreviewTabId.make("tab-a"),
        },
      });
    const mintedA = yield* mintA("conn-a");
    expect(Option.isSome(mintedA)).toBe(true);
    const ticketA = Option.getOrThrow(mintedA).inputTicket;
    expect(Option.isSome(yield* leases.verify(ticketA))).toBe(true);
    yield* sessions.markDisconnected(session!.sessionId, "conn-a");
    yield* leases.revokeConnection("conn-a");
    expect(Option.isNone(yield* leases.verify(ticketA))).toBe(true);
    // A revoked connection can never mint again — the in-flight-mint hole.
    expect(Option.isNone(yield* mintA("conn-a"))).toBe(true);
    // And the captured root's revalidation fails now that its connection is
    // dead, so a brokered invoke cannot proceed under it either.
    const rootA = f.roots[0];
    expect(rootA).toBeDefined();
    const revalidated = yield* Effect.promise(() =>
      Promise.resolve(rootA!.revalidate()).then(
        () => "ok" as const,
        () => "denied" as const,
      ),
    );
    expect(revalidated).toBe("denied");
    // B's socket still binds correctly after A's teardown.
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-b")).status).toBe(
      200,
    );
    expect(f.roots[3]?.connectionId).toBe("conn-b");
    // Disconnecting B turns its instance header stale — the request fails by
    // name instead of minting a connectionless root nobody can revoke.
    yield* sessions.markDisconnected(session!.sessionId, "conn-b");
    yield* leases.revokeConnection("conn-b");
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-b")).status).toBe(
      400,
    );
    expect(f.roots).toHaveLength(4);
    // A reconnect restores the binding — the fresh connection owns its mints
    // and a second disconnect fences them and the stale header again.
    yield* sessions.markConnected(session!.sessionId, "conn-b2", "inst-b");
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-b")).status).toBe(
      200,
    );
    expect(f.roots[4]?.connectionId).toBe("conn-b2");
    const mintedB2 = yield* mintA("conn-b2");
    expect(Option.isSome(mintedB2)).toBe(true);
    const ticketB2 = Option.getOrThrow(mintedB2).inputTicket;
    yield* sessions.markDisconnected(session!.sessionId, "conn-b2");
    yield* leases.revokeConnection("conn-b2");
    expect(Option.isNone(yield* leases.verify(ticketB2))).toBe(true);
    expect((yield* request("api/invoke", apiInvoke, token.access_token, "inst-b")).status).toBe(
      400,
    );
    expect(f.roots).toHaveLength(5);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        realAuthLayer,
        BrowserFrameLeases.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);

it.effect("asset bytes require read scope and carry no-store/nosniff headers", () =>
  Effect.gen(function* () {
    const input = {
      id: "fixture",
      expectedContentHash: "a".repeat(64),
      path: "assets/renderer.wasm",
    };
    const denied = fixture([AuthAccessWriteScope]);
    expect((yield* denied.provide(Effect.flip(denied.operations.asset(input))))._tag).toBe(
      "EnvironmentScopeRequiredError",
    );
    expect(denied.called).toEqual([]);
    const allowed = fixture([AuthOrchestrationReadScope]);
    const result = yield* allowed.provide(allowed.operations.asset(input));
    expect(result.body).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(result.headers).toEqual({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(allowed.called).toEqual(["asset"]);
  }),
);
it.effect("revocation during asset read prevents successful bytes", () =>
  Effect.gen(function* () {
    let revoked = false;
    const f = fixture([AuthOrchestrationReadScope], {
      read: () => {
        revoked = true;
        return new Uint8Array([1]);
      },
      revalidate: () => {
        if (revoked) throw new Error("revoked");
      },
    });
    const error = yield* f.provide(
      Effect.flip(
        f.operations.asset({
          id: "fixture",
          expectedContentHash: "a".repeat(64),
          path: "asset.wasm",
        }),
      ),
    );
    expect(error._tag).toBe("ExtensionOperationError");
    expect(f.called).toEqual(["asset"]);
  }),
);
