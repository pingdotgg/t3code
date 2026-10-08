import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  type AuthMcpClientAccess,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

class PeerTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

export const descriptorOf = (
  environmentId: string,
  label: string,
  capabilities: Partial<ExecutionEnvironmentDescriptor["capabilities"]> = {},
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    mcpModeLimitHeader: true,
    linkFence: true,
    ...capabilities,
  },
});

/**
 * The environment a link points at, as it runs: its descriptor, MCP OAuth,
 * and `/mcp` with `tools` behind the real client authenticator, on a real
 * socket. The descriptor can be swapped, as when its address comes to answer
 * as another environment, and every bearer it receives is recorded.
 */
export const servePeer = <E, R>(
  initial: ExecutionEnvironmentDescriptor,
  tools: Layer.Layer<never, E, R>,
) =>
  Effect.gen(function* () {
    const descriptor = yield* Ref.make(initial);
    const bearers = yield* Ref.make<ReadonlyArray<string>>([]);
    const probes = yield* Ref.make(0);
    const layerEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Ref.get(descriptor).pipe(Effect.map((current) => current.environmentId)),
      getDescriptor: Ref.get(descriptor),
    });
    const authContext = yield* EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-peer-" })),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    const layerRecordBearers = HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/.well-known/t3/environment")) {
            yield* Ref.update(probes, (count) => count + 1);
          }
          const authorization = request.headers.authorization;
          if (authorization !== undefined) {
            yield* Ref.update(bearers, (seen) => [...seen, authorization]);
          }
          return yield* httpEffect;
        }),
      { global: true },
    );
    const layerRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(PeerTestApi).pipe(
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      tools.pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      ),
    ).pipe(
      Layer.provide(layerRecordBearers),
      Layer.provide(layerEnvironment),
      Layer.provide(Layer.succeedContext(authContext)),
    );
    // Fresh, so the peer never shares a toolkit or MCP server with the
    // environment that links to it in the same test.
    yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
    );
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    return {
      url,
      auth,
      descriptor,
      bearers,
      /** How often its descriptor was asked for, as a probe of whether it answers. */
      probes,
      /** The sessions linking created there, which its Connections lists. */
      linkedSessions: auth
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.client.label?.startsWith("T3 Code · ")),
          ),
        ),
    };
  });

export type ServedPeer = Effect.Success<ReturnType<typeof servePeer>>;

/**
 * The environment that links: its own database and secret store, reaching
 * peers over plain HTTP. Provide it to anything built on its links.
 */
export const layerLinkingEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  PeerMcpClient.layer.pipe(
    Layer.provideMerge(PeerLinks.layer),
    Layer.provide(
      Layer.mergeAll(
        Sqlite.layerMemory,
        ServerSecretStore.layer,
        FetchHttpClient.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-here-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
  );

/** Links `links` to `peer` with a fresh pairing code from it. */
export const linkTo = (
  links: PeerLinks.PeerLinks["Service"],
  peer: ServedPeer,
  access: AuthMcpClientAccess = "auto",
) =>
  peer.auth
    .issuePairingCredential()
    .pipe(
      Effect.flatMap((pairing) =>
        links.link({ url: peer.url, pairingCode: pairing.credential, access }),
      ),
    );
