import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { httpServer } from "../Util/PlatformServices.ts";
import {
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "./RpcServerEnvironment.ts";

export class RpcSpawner extends Context.Service<
  RpcSpawner,
  {
    readonly url: string;
  }
>()("alchemy/Local/RpcSpawner") {}

export interface RpcSpawnPayload extends Pick<
  RpcServerEnvironment,
  "alchemyContext" | "stack"
> {
  serverEntryUrl: string;
}

export const make = Effect.fnUntraced(function* ({
  profile,
  envFile,
}: Pick<RpcServerEnvironment, "profile" | "envFile">) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const cache = yield* Cache.make({
    lookup: (payload: RpcSpawnPayload) =>
      spawn(payload).pipe(Scope.provide(scope)),
    capacity: Infinity,
  });

  const spawn = Effect.fnUntraced(function* ({
    serverEntryUrl,
    alchemyContext,
    stack,
  }: RpcSpawnPayload) {
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const main = fileURLToPath(serverEntryUrl);
    const environment: RpcServerEnvironment = {
      profile,
      envFile,
      alchemyContext,
      stack,
    };
    const command = ChildProcess.make(
      bin,
      {
        bun: ["run", main],
        // Under Node, transparently strip TypeScript types so that `.ts`
        // entry points work the same way they do under Bun. Mirrors what
        // `dev.ts` already does for the outer process, so the dev experience
        // is symmetric on both runtimes whether the entry came from `src/`
        // (dev/tests) or `lib/` (published packages).
        node: main.endsWith(".ts")
          ? [
              "--experimental-transform-types",
              "--no-warnings=ExperimentalWarning",
              main,
            ]
          : [main],
      }[bin],
      {
        stdout: "pipe",
        stderr: "inherit",
        detached: false,
        env: {
          [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(environment),
        },
        extendEnv: true,
      },
    );
    const handle = yield* spawner.spawn(command);
    const unregister = exitHook(() => {
      killProcessGroup(handle.pid, "SIGKILL");
    });
    const kill = handle
      .kill({ forceKillAfter: "500 millis" })
      .pipe(Effect.tap(() => Effect.sync(unregister)));
    yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore));
    const url = yield* getRpcAddress(handle.stdout);
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(new URL("/parent", url))),
      (ws) => Effect.sync(() => ws.close()),
    );
    return {
      url,
      isRunning: Effect.zipWith(
        handle.isRunning,
        Effect.sync(
          () =>
            ws.readyState === WebSocket.CONNECTING ||
            ws.readyState === WebSocket.OPEN,
        ),
        (a, b) => a && b,
        { concurrent: true },
      ),
      kill,
    };
  });

  const register = Effect.fnUntraced(function* (
    payload: RpcSpawnPayload,
    attempt = 0,
  ): Effect.fn.Return<string, PlatformError> {
    const child = yield* Cache.get(cache, payload);
    if (yield* child.isRunning) {
      return child.url;
    }
    if (attempt > 3) {
      return yield* Effect.die(
        new Error(
          `Failed to spawn RPC server for "${payload.serverEntryUrl}" after ${attempt} attempts.`,
        ),
      );
    }
    yield* child.kill;
    yield* Cache.invalidate(cache, payload);
    return yield* register(payload, attempt + 1);
  });

  const server = yield* HttpServer.HttpServer;

  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const payload = (yield* request.json) as unknown as RpcSpawnPayload;
      const url = yield* register(payload);
      return HttpServerResponse.text(url);
    }),
  );

  return RpcSpawner.of({
    url: HttpServer.formatAddress(server.address),
  });
});

export const layerServer = (
  environment: Pick<RpcServerEnvironment, "profile" | "envFile">,
) =>
  Layer.effect(RpcSpawner, make(environment)).pipe(Layer.provide(httpServer()));

const RPC_ADDRESS_REGEX =
  /(<ALCHEMY_RPC_ADDRESS>)(.+)(<\/ALCHEMY_RPC_ADDRESS>)/;

const getRpcAddress = (stdout: Stream.Stream<Uint8Array, PlatformError>) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    let done = false;
    yield* stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (done) {
          console.log(line);
        } else {
          const match = line.match(RPC_ADDRESS_REGEX);
          if (match) {
            done = true;
            return Deferred.succeed(address, match[2]);
          }
        }
        return Effect.void;
      }),
      Effect.forkScoped,
    );
    return yield* Deferred.await(address);
  });

const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") {
      NodeChildProcess.execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // ignore errors during best-effort cleanup
  }
};
