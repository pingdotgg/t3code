import * as Cache from "effect/Cache";
import type * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import { transformTypesFlags } from "../Util/Node.ts";
import { httpServer } from "../Util/PlatformServices.ts";
import { SPAWNER_URL_ENV_KEY } from "./RpcProviderProxy.ts";
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

/**
 * The spawner forks one child per distinct `serverEntryUrl`. Stack-specific
 * context (stack name/stage, AlchemyContext) is NOT part of the spawn key —
 * it travels per RPC session (see `SESSION_ENV_PARAM`), so many stacks
 * (e.g. every test file in a run) share a single sidecar process.
 */
export interface RpcSpawnPayload {
  serverEntryUrl: string;
}

/**
 * One line of sidecar child output, tagged with the channel it arrived on.
 * Streamed as NDJSON over the spawner's {@link LOGS_PATH} endpoint.
 */
export interface SidecarLogLine {
  readonly channel: "stdout" | "stderr";
  readonly line: string;
}

/**
 * Path on the spawner's HTTP server that streams sidecar output as NDJSON
 * ({@link SidecarLogLine} per line). Consumed by {@link forwardSidecarLogs}
 * from the exec child, which owns the terminal renderer.
 */
export const LOGS_PATH = "/logs";

export const make = Effect.fn(function* ({
  profile,
  envFile,
}: Pick<RpcServerEnvironment, "profile" | "envFile">) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const cache = yield* Cache.make({
    lookup: (serverEntryUrl: string) =>
      spawn(serverEntryUrl).pipe(Scope.provide(scope)),
    capacity: Infinity,
  });

  // Sidecar output hub. During `alchemy dev` this process (the outer dev
  // command) shares the tty with the exec child, and the exec child owns the
  // repainting progress renderer (Ink patches its `console`). Printing
  // sidecar lines RAW from here interleaves with the renderer's repaints and
  // corrupts the region (stacked/duplicated frames). So: when an exec child
  // is subscribed via the /logs endpoint, hand lines to it and let it print
  // through its (patched) console; only print from this process as a
  // fallback when no subscriber is connected (e.g. during a --watch restart
  // gap, when no renderer is alive either).
  const subscribers = new Set<(line: SidecarLogLine) => void>();
  const publish = (line: SidecarLogLine): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (subscribers.size > 0) {
        for (const notify of subscribers) notify(line);
        return Effect.void;
      }
      // Through the Console SERVICE so runners that override it (e.g.
      // alchemy-test's per-test buffer) capture the sidecar's output.
      return line.channel === "stderr"
        ? Console.error(line.line)
        : Console.log(line.line);
    });

  const spawn = Effect.fn(function* (serverEntryUrl: string) {
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const main = fileURLToPath(serverEntryUrl);
    // Stack-specific context is deliberately absent: sessions carry their
    // own SessionEnvironment, so one child serves every stack.
    const environment: RpcServerEnvironment = {
      profile,
      envFile,
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
        node: main.endsWith(".ts") ? [...transformTypesFlags(), main] : [main],
      }[bin],
      {
        stdout: "pipe",
        // Piped (NOT inherited) so the child's output routes through the
        // Effect Console service: raw writes to the parent's fd corrupt the
        // test runner's reporter/TUI. The drain below is mandatory — an
        // unread pipe eventually fills and blocks the child.
        stderr: "pipe",
        detached: false,
        env: {
          [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(environment),
        },
        extendEnv: true,
      },
    );
    const handle = yield* spawner.spawn(command);
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => publish({ channel: "stderr", line })),
      Effect.ignore,
      Effect.forkScoped,
    );
    // This scope is the child handle's sole owner. Graceful shutdown runs this
    // finalizer; abrupt parent loss closes the RPC parent connection and the
    // child self-terminates (both paths are covered by RpcSpawnerCleanup).
    const kill = handle.kill({ forceKillAfter: "500 millis" });
    yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore));
    const url = yield* getRpcAddress(handle.stdout, (line) =>
      publish({ channel: "stdout", line }),
    );
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

  const register = Effect.fn(function* (
    serverEntryUrl: string,
    attempt = 0,
  ): Effect.fn.Return<string, PlatformError> {
    const child = yield* Cache.get(cache, serverEntryUrl);
    if (yield* child.isRunning) {
      return child.url;
    }
    if (attempt > 3) {
      return yield* Effect.die(
        new Error(
          `Failed to spawn RPC server for "${serverEntryUrl}" after ${attempt} attempts.`,
        ),
      );
    }
    yield* child.kill;
    yield* Cache.invalidate(cache, serverEntryUrl);
    return yield* register(serverEntryUrl, attempt + 1);
  });

  const server = yield* HttpServer.HttpServer;

  const encoder = new TextEncoder();

  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.url.startsWith(LOGS_PATH)) {
        // Long-lived NDJSON stream of sidecar output. The subscriber (exec
        // child) prints these lines through its own console, which the Ink
        // renderer patches — inserting them above the progress region
        // instead of tearing it. Client disconnect interrupts the stream
        // and unregisters the subscriber.
        const queue = yield* Queue.make<Uint8Array, Cause.Done>();
        const notify = (line: SidecarLogLine) => {
          Queue.offerUnsafe(queue, encoder.encode(`${JSON.stringify(line)}\n`));
        };
        subscribers.add(notify);
        return HttpServerResponse.stream(
          Stream.fromQueue(queue).pipe(
            Stream.ensuring(Effect.sync(() => subscribers.delete(notify))),
          ),
          { contentType: "application/x-ndjson" },
        );
      }
      const payload = (yield* request.json) as unknown as RpcSpawnPayload;
      const url = yield* register(payload.serverEntryUrl);
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

const getRpcAddress = (
  stdout: Stream.Stream<Uint8Array, PlatformError>,
  publish: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    let done = false;
    yield* stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (done) {
          return publish(line);
        }
        const match = line.match(RPC_ADDRESS_REGEX);
        if (match) {
          done = true;
          return Deferred.succeed(address, match[2]);
        }
        return Effect.void;
      }),
      Effect.forkScoped,
    );
    return yield* Deferred.await(address);
  });

const parseSidecarLogLine = (raw: string): SidecarLogLine | undefined => {
  try {
    const parsed = JSON.parse(raw) as SidecarLogLine;
    return typeof parsed?.line === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Pull sidecar output from the spawner (the outer `alchemy dev` process)
 * into THIS process's Console. The exec child owns the terminal renderer —
 * Ink patches its `console`, so lines printed here are inserted cleanly
 * above the repainting progress region instead of racing it on the shared
 * tty. Forks in the ambient scope and never fails: when no spawner is
 * configured (`ALCHEMY_RPC_SPAWNER_URL` absent — plain deploy/destroy) it is
 * a no-op, and if the connection drops the spawner's own fallback printing
 * takes over.
 */
export const forwardSidecarLogs: Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | Scope.Scope
> = Config.string(SPAWNER_URL_ENV_KEY).pipe(
  Effect.flatMap((spawnerUrl) => {
    const streamOnce = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(
        new URL(LOGS_PATH, spawnerUrl).toString(),
      );
      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((raw) =>
          Effect.suspend(() => {
            const parsed = parseSidecarLogLine(raw);
            if (parsed === undefined) return Effect.void;
            return parsed.channel === "stderr"
              ? Console.error(parsed.line)
              : Console.log(parsed.line);
          }),
        ),
      );
    });
    // Keep the subscription alive for the whole dev session: reconnect
    // (paced) if the stream ends or errors. While disconnected the spawner's
    // fallback printing covers the gap; the loop dies with the ambient scope.
    return streamOnce.pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
    );
  }),
  Effect.ignore,
  Effect.forkScoped,
  Effect.asVoid,
);
