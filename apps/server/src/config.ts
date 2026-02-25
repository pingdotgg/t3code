import * as Net from "node:net";
import { Data, Effect, FileSystem, Layer, Path, ServiceMap } from "effect";

export const DEFAULT_PORT = 3773;

export type RuntimeMode = "web" | "desktop";

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
}

export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "server/ServerConfig",
) {}

// Helpers

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NetServiceShape {
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
}

export class NetService extends ServiceMap.Service<NetService, NetServiceShape>()(
  "server/NetService",
) {
  static readonly layer = Layer.succeed(NetService, {
    findAvailablePort: (preferred) =>
      Effect.callback<number, NetError>((resume) => {
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
        });
      }),
  });
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { stat } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* stat(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* stat(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
