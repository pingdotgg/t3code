import * as Cache from "effect/Cache";
import type * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import { pipedColorEnv } from "../Util/Terminal.ts";
import { nodeLoaderArgs } from "../Util/Node.ts";
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
export const RpcSpawnPayload = Schema.Struct({ serverEntryUrl: Schema.String });
export type RpcSpawnPayload = typeof RpcSpawnPayload.Type;

/**
 * One line of sidecar child output, tagged with the channel it arrived on.
 * Streamed as NDJSON over the spawner's {@link LOGS_PATH} endpoint.
 */
export interface SidecarLogLine {
  readonly channel: "stdout" | "stderr";
  readonly line: string;
}

export const HeartbeatFrame = Schema.Struct({
  channel: Schema.Literal("heartbeat"),
});
export type HeartbeatFrame = typeof HeartbeatFrame.Type;

const SidecarLogLineSchema = Schema.Struct({
  channel: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
});

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
  // repainting progress renderer. Printing sidecar lines RAW from here
  // interleaves with the renderer's repaints and corrupts the region
  // (stacked/duplicated frames). So: when an exec child is subscribed via
  // the /logs endpoint, hand lines to it and let its logger route them into
  // the renderer; only log from this process as a fallback when no
  // subscriber is connected (e.g. during a --watch restart gap, when no
  // renderer is alive either).
  const subscribers = new Set<(line: SidecarLogLine) => void>();
  const publish = (line: SidecarLogLine): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (subscribers.size > 0) {
        for (const notify of subscribers) notify(line);
        return Effect.void;
      }
      // Fallback path (no exec child subscribed): sidecar lines already carry
      // the sidecar's logger prefix, so print verbatim rather than stamping
      // this process's logger prefix on top.
      return line.channel === "stderr"
        ? Console.error(line.line)
        : Console.log(line.line);
    });

  const spawn = Effect.fn(function* (serverEntryUrl: string) {
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const main = fileURLToPath(serverEntryUrl);
    // The sidecar runs on THIS process's runtime binary, not whatever PATH
    // resolves: a `.ts` entry (checkout) needs the dev-mode loader hooks,
    // which are gated on this node's version, and a published `.js` entry
    // must not silently switch Node versions between supervisor and sidecar.
    const program = bin === "bun" ? "bun" : process.execPath;
    // Stack-specific context is deliberately absent: sessions carry their
    // own SessionEnvironment, so one child serves every stack.
    const environment: RpcServerEnvironment = {
      profile,
      envFile,
    };
    // Sidecar stdio is piped, so toolchains down the chain (vite, workerd,
    // pretty loggers) detect a non-TTY and drop ANSI colors — but their
    // output ultimately renders on THIS process's terminal. Force color
    // through the pipe when that terminal supports it, unless the user
    // already decided (NO_COLOR / FORCE_COLOR). `extendEnv` propagates it
    // from the sidecar to its own children (dev servers, workerd).
    const command = ChildProcess.make(
      program,
      {
        bun: ["run", main],
        // Under Node the sidecar starts with alchemy's Oxc loader hooks, the
        // same way `dev.ts` starts the exec child: a `.ts` entry (src/ in a
        // checkout) also gets src-condition resolution, a `.js` entry (lib/
        // in a published install) gets the loader alone.
        node: [...nodeLoaderArgs(main), main],
      }[bin],
      {
        stdout: "pipe",
        // Piped (NOT inherited) so the child's output routes through the
        // Effect Console service: raw writes to the parent's fd corrupt the
        // test runner's reporter/TUI. The drain below is mandatory — an
        // unread pipe eventually fills and blocks the child.
        stderr: "pipe",
        // `detached` deliberately unset: the spawner defaults to a new process
        // group on POSIX (and none on Windows, where a detached console child
        // has its own quirks). A terminal Ctrl+C must NOT reach the sidecar
        // directly — its lifecycle belongs to this process's finalizer (the
        // bounded kill below), and a sidecar tearing itself down concurrently
        // yanks local providers out from under the exec child mid-shutdown.
        // As a group leader the kill also reaps the sidecar's own children
        // (workerd, emulators) instead of orphaning them.
        env: {
          [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(environment),
          ...pipedColorEnv(),
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
  // The first heartbeat flushes the response headers immediately; the
  // periodic ones defeat idle timeouts (Bun kills sockets that stay silent
  // for ~10s). Entries without a `line` are skipped by the client.
  const heartbeat: HeartbeatFrame = { channel: "heartbeat" };
  const HEARTBEAT = encoder.encode(`${JSON.stringify(heartbeat)}\n`);
  const heartbeats = Stream.make(HEARTBEAT).pipe(
    Stream.concat(
      Stream.fromSchedule(Schedule.spaced(Duration.seconds(5))).pipe(
        Stream.map(() => HEARTBEAT),
      ),
    ),
  );

  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      // `request.url` is relative under Node and absolute under Bun —
      // normalize to the pathname before matching.
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === LOGS_PATH) {
        // Long-lived NDJSON stream of sidecar output. The subscriber (exec
        // child) routes these lines through its logger, which the renderer
        // inserts above the progress region instead of tearing it. Client
        // disconnect interrupts the stream and unregisters the subscriber.
        const queue = yield* Queue.make<Uint8Array, Cause.Done>();
        const notify = (line: SidecarLogLine) => {
          Queue.offerUnsafe(queue, encoder.encode(`${JSON.stringify(line)}\n`));
        };
        subscribers.add(notify);
        return HttpServerResponse.stream(
          Stream.merge(
            Stream.fromQueue(queue).pipe(
              Stream.ensuring(Effect.sync(() => subscribers.delete(notify))),
            ),
            heartbeats,
          ),
          { contentType: "application/x-ndjson" },
        );
      }
      const decoded = yield* Effect.result(
        request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RpcSpawnPayload)),
        ),
      );
      if (decoded._tag === "Failure") {
        return HttpServerResponse.text("Invalid RPC spawn payload.", {
          status: 400,
        });
      }
      const entry = yield* Effect.result(
        Effect.try({
          try: () => new URL(decoded.success.serverEntryUrl),
          catch: (cause) => cause,
        }),
      );
      if (entry._tag === "Failure" || entry.success.protocol !== "file:") {
        return HttpServerResponse.text(
          "serverEntryUrl must be a valid file URL.",
          { status: 400 },
        );
      }
      const url = yield* register(entry.success.href);
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
  Layer.effect(RpcSpawner, make(environment)).pipe(
    // `/logs` is deliberately long-lived. On shutdown the exec child still
    // owns that response while this scope owns the exec child, so waiting for
    // Node's default 20-second graceful HTTP drain creates a finalizer cycle.
    // Stop accepting/serving immediately so the watcher finalizer can close
    // the child; all actual sidecars still use their own bounded finalizers.
    Layer.provide(httpServer(0, "127.0.0.1", { gracefulShutdownTimeout: 0 })),
  );

const RPC_ADDRESS_REGEX =
  /(<ALCHEMY_RPC_ADDRESS>)(.+)(<\/ALCHEMY_RPC_ADDRESS>)/;

const getRpcAddress = (
  stdout: Stream.Stream<Uint8Array, PlatformError>,
  publish: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const address = yield* Deferred.make<string>();
    // Set once the address line is seen; lines before it are handshake noise.
    let addressSeen = false;
    yield* stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const match = line.match(RPC_ADDRESS_REGEX);
        if (match) {
          addressSeen = true;
          return Deferred.succeed(address, match[2]);
        }
        return addressSeen ? publish(line) : Effect.void;
      }),
      Effect.forkScoped,
    );
    return yield* Deferred.await(address);
  });

export const parseSidecarLogLine = (
  raw: string,
): SidecarLogLine | undefined => {
  try {
    return Schema.decodeUnknownOption(SidecarLogLineSchema)(
      JSON.parse(raw),
    ).pipe(Option.getOrUndefined);
  } catch {
    return undefined;
  }
};

/**
 * Pull sidecar output from the spawner (the outer `alchemy dev` process)
 * into THIS process's Console. The exec child owns the terminal renderer —
 * Sigil patches its `console`, so lines printed here are inserted cleanly
 * above the repainting progress region instead of racing it on the shared
 * tty. Forks in the ambient scope and never fails: when no spawner is
 * configured (`ALCHEMY_RPC_SPAWNER_URL` absent — plain deploy/destroy) it is
 * a no-op, and if the connection drops the spawner's own fallback printing
 * takes over.
 */
export const forwardSidecarLogs = (
  /** Mirrors every forwarded line (e.g. into a dev log file). */
  tee?: (line: SidecarLogLine) => void,
): Effect.Effect<void, never, HttpClient.HttpClient | Scope.Scope> =>
  Config.String(SPAWNER_URL_ENV_KEY).pipe(
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
              tee?.(parsed);
              // Sidecar lines already carry the sidecar's own logger prefix
              // (timestamp/level/fiber) — print them verbatim; routing through
              // this process's logger would stamp a second prefix on top.
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
