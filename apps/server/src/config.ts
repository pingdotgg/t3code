/**
 * ServerConfig and NetService - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import * as Net from "node:net";
import { Data, Effect, FileSystem, Layer, Path, ServiceMap } from "effect";

export const DEFAULT_PORT = 3773;

export type RuntimeMode = "web" | "desktop";

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape {
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly keybindingsConfigPath: string;
  readonly stateDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly authToken: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
}

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "t3/config/ServerConfig",
) {}

// Helpers

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * NetServiceShape - Networking helper operations used during startup.
 */
export interface NetServiceShape {
  /**
   * Resolve an available listening port, preferring the provided port first.
   *
   * Falls back to an ephemeral OS-assigned port when the preferred port is in use.
   */
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
}

/**
 * NetService - Service tag for startup networking helpers.
 */
export class NetService extends ServiceMap.Service<NetService, NetServiceShape>()(
  "t3/config/NetService",
) {
  static readonly layer = Layer.succeed(NetService, {
    findAvailablePort: (preferred) =>
      Effect.callback<number, NetError>((resume) => {
        let fallbackServer: Net.Server | null = null;
        const server = Net.createServer();
        server.listen(preferred, () => {
          server.close(() => resume(Effect.succeed(preferred)));
        });
        server.on("error", () => {
          const fallback = Net.createServer();
          fallback.listen(0, () => {
            const addr = fallback.address();
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            fallback.close(() => {
              resume(
                port > 0
                  ? Effect.succeed(port)
                  : Effect.fail(new NetError({ message: "Could not find an available port." })),
              );
            });
          });
          fallback.on("error", (cause) => {
            resume(
              Effect.fail(new NetError({ message: "Failed to find an available port", cause })),
            );
          });
          fallbackServer = fallback;
        });

        return Effect.sync(() => {
          server.close();
          fallbackServer?.close();
        });
      }),
  });
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
