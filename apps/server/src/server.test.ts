import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpServer, HttpServerError } from "effect/http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as ServerConfig from "./config.ts";
import { layerHttpServer } from "./server.ts";

// Holds a port on a specific non-loopback address, so a wildcard bind on that
// port fails with EADDRINUSE while a loopback bind is still free.
const occupyNonLoopbackPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server & { readonly port: number }>((resume) => {
    const address = Object.values(NodeOS.networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (address === undefined) throw new Error("no non-loopback IPv4 interface");
    const blocker = NodeNet.createServer();
    blocker.listen(0, address, () => {
      const bound = blocker.address() as NodeNet.AddressInfo;
      resume(Effect.succeed(Object.assign(blocker, { port: bound.port })));
    });
  }),
  (blocker) => Effect.callback<void>((resume) => void blocker.close(() => resume(Effect.void))),
);

const httpServerWithConfig = (
  overrides: Pick<ServerConfig.ServerConfig["Service"], "host" | "port" | "privateNetworkOnly">,
) =>
  layerHttpServer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, ...overrides })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-bind-test-" })),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

it.live("managed service falls back to loopback when its wildcard port is taken", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* occupyNonLoopbackPort;
      const { address, config } = yield* Effect.all({
        address: Effect.map(HttpServer.HttpServer, (server) => server.address),
        config: ServerConfig.ServerConfig,
      }).pipe(
        Effect.provide(httpServerWithConfig({ host: "0.0.0.0", port, privateNetworkOnly: true })),
      );
      assert.strictEqual(config.host, "127.0.0.1");
      const listening =
        address._tag === "InetAddressV4"
          ? `${String(address.address)}:${address.port}`
          : address._tag;
      assert.strictEqual(listening, `127.0.0.1:${port}`);
    }),
  ),
);

it.live("an explicit wildcard host still fails when its port is taken", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* occupyNonLoopbackPort;
      const exit = yield* HttpServer.HttpServer.pipe(
        Effect.provide(
          httpServerWithConfig({ host: "0.0.0.0", port, privateNetworkOnly: undefined }),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.instanceOf(error, HttpServerError.ServeError);
      assert.propertyVal(error.cause, "code", "EADDRINUSE");
    }),
  ),
);
