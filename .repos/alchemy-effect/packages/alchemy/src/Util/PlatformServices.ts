import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { Teardown } from "effect/Runtime";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { HttpServer } from "effect/unstable/http/HttpServer";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { WebSocketConstructor } from "effect/unstable/socket/Socket";

const isBun = typeof Bun !== "undefined";

/**
 * Constructs a layer with different implementations for Bun and Node.
 */
export const platformLayer = <A, E, R>(constructors: {
  bun: () => Promise<Layer.Layer<A, E, R>>;
  node: () => Promise<Layer.Layer<A, E, R>>;
}) =>
  Layer.unwrap(
    Effect.promise(async () => {
      if (isBun) {
        return await constructors.bun();
      } else {
        return await constructors.node();
      }
    }),
  );

export type PlatformServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal
  // WebSocketConstructor is not included in NodeServices/BunServices, but required for Workers tail
  | WebSocketConstructor;

export const PlatformServices: Layer.Layer<PlatformServices> = platformLayer({
  bun: async () => {
    const [BunServices, BunSocket] = await Promise.all([
      import("@effect/platform-bun/BunServices"),
      import("@effect/platform-bun/BunSocket"),
    ]);
    return Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor);
  },
  node: async () => {
    const [NodeServices, NodeSocket] = await Promise.all([
      import("@effect/platform-node/NodeServices"),
      import("@effect/platform-node/NodeSocket"),
    ]);
    return Layer.merge(
      NodeServices.layer,
      NodeSocket.layerWebSocketConstructor,
    );
  },
});

export const runMain = <E, A>(
  effect: Effect.Effect<A, E>,
  options?: {
    readonly disableErrorReporting?: boolean | undefined;
    readonly teardown?: Teardown | undefined;
  },
): void => {
  if (isBun) {
    void import("@effect/platform-bun/BunRuntime").then((BunRuntime) =>
      BunRuntime.runMain(effect, options),
    );
  } else {
    void import("@effect/platform-node/NodeRuntime").then((NodeRuntime) =>
      NodeRuntime.runMain(effect, options),
    );
  }
};

export const httpServer = (
  port: number = 0,
  host: string = "127.0.0.1",
): Layer.Layer<HttpServer, ServeError> =>
  platformLayer({
    bun: async () => {
      const BunHttpServer = await import("@effect/platform-bun/BunHttpServer");
      return BunHttpServer.layer({ hostname: host, port });
    },
    node: async () => {
      const [NodeHttpServer, Http] = await Promise.all([
        import("@effect/platform-node/NodeHttpServer"),
        import("node:http"),
      ]);
      return NodeHttpServer.layerServer(Http.createServer, { host, port });
    },
  });
