import { unwrapRpcHandlers } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import {
  encodeSessionEnvironment,
  SESSION_ENV_PARAM,
} from "@/Local/RpcServerEnvironment.ts";
import {
  layerServer,
  RpcSpawner,
  LOGS_PATH,
  parseSidecarLogLine,
  type RpcSpawnPayload,
} from "@/Local/RpcSpawner.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  assertPidExited,
  canOpenWebSocket,
  isAlive,
  openWebSocket,
  pgidOf,
  pidListeningOn,
} from "./fixtures/process-effect.ts";

const FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();
const FIXTURE_B_TS_URL = new URL(
  "./fixtures/rpc-server-entry-b.ts",
  import.meta.url,
).toString();
const CRASH_FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-crash.ts",
  import.meta.url,
).toString();
const LOGS_FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-logs.ts",
  import.meta.url,
).toString();

const samplePayload = (serverEntryUrl: string): RpcSpawnPayload => ({
  serverEntryUrl,
});

// The spawner inherits the runtime that vitest itself is running under
// (it shells out to `bun` or `node` based on `typeof Bun`). These tests
// only verify behavior for the active runtime; run vitest under both to
// get full coverage.
describe(`Local.RpcSpawner (runtime=${typeof globalThis.Bun !== "undefined" ? "bun" : "node"})`, () => {
  /**
   * The Spawner layer (and any child processes it spawns) is torn down
   * when the surrounding test scope closes, so we provide it at the test
   * boundary rather than wrapping a sub-effect — that would tear the
   * server down the moment the sub-effect returned.
   */
  const services = Layer.provideMerge(
    layerServer({ profile: undefined, envFile: undefined }),
    Layer.merge(PlatformServices, FetchHttpClient.layer),
  );

  it.live(
    "POST returns a ws url whose RPC end-to-end call hits the fixture",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const wsUrl = yield* post(url, samplePayload(FIXTURE_TS_URL));
        expect(wsUrl).toMatch(/^ws:\/\//);
        const result = yield* echoWebSocket(wsUrl, "hello");
        expect(result).toBe("echo:hello");
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it.live(
    "rejects malformed spawn payloads and non-file URLs",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        for (const payload of [
          {},
          { serverEntryUrl: 42 },
          { serverEntryUrl: "not a url" },
          { serverEntryUrl: "https://example.com/server.ts" },
        ]) {
          const response = yield* postRaw(url, payload);
          expect(response.status).toBe(400);
        }
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it("client parser ignores heartbeat frames", () => {
    expect(parseSidecarLogLine('{"channel":"heartbeat"}')).toBeUndefined();
  });

  it.live(
    "emits a heartbeat immediately and periodically",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(new URL(LOGS_PATH, url).toString());
        const frames = yield* response.stream.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map((line) => JSON.parse(line) as { channel: string }),
          Stream.filter(({ channel }) => channel === "heartbeat"),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout(Duration.seconds(7)),
        );
        expect(Array.from(frames)).toEqual([
          { channel: "heartbeat" },
          { channel: "heartbeat" },
        ]);
      }).pipe(Effect.provide(services)),
    { timeout: 10_000 },
  );

  it.live(
    "caches the child by entry url: a second POST returns the same url",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const payload = samplePayload(FIXTURE_TS_URL);
        const first = yield* post(url, payload);
        const second = yield* post(url, payload);
        expect(second).toBe(first);
        const pid = yield* pidListeningOn(first);
        if (pid !== undefined) {
          expect(yield* isAlive(pid)).toBe(true);
        }
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it.live(
    "distinct entry urls spawn distinct children with distinct urls",
    () =>
      Effect.gen(function* () {
        // Children are keyed by serverEntryUrl ONLY — stacks share one child
        // (each RPC session carries its own stack environment), so the second
        // fixture must be a genuinely different entry module.
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const a = yield* post(url, samplePayload(FIXTURE_TS_URL));
        const b = yield* post(url, samplePayload(FIXTURE_B_TS_URL));
        expect(a).not.toBe(b);
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it.live(
    "sidecars lead their own process group (a terminal Ctrl+C cannot reach them)",
    () =>
      Effect.gen(function* () {
        // POSIX-only: Windows has no process groups; the spawner leaves
        // sidecars attached there (detached console children have their own
        // quirks) and Ctrl+C delivery works differently anyway.
        if (process.platform === "win32") return;
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const wsUrl = yield* post(url, samplePayload(FIXTURE_TS_URL));
        const pid = yield* pidListeningOn(wsUrl);
        if (pid === undefined || Number.isNaN(pid)) return;
        // Group leader (pgid === pid) proves the sidecar was spawned
        // detached: the tty's foreground-group signals stop at this process.
        expect(yield* pgidOf(pid)).toBe(pid);
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it.live(
    "closing the spawner's scope kills all spawned children",
    () =>
      Effect.gen(function* () {
        // Boot the spawner in an inner scope so we can close it while
        // the outer test scope is still alive, then assert against the
        // pid we recorded.
        const pid = yield* Effect.gen(function* () {
          const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
          const wsUrl = yield* post(url, samplePayload(FIXTURE_TS_URL));
          return yield* pidListeningOn(wsUrl);
        }).pipe(Effect.provide(services), Effect.scoped);

        if (pid === undefined) return;
        yield* assertPidExited(pid);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "url returned for a crash-on-boot fixture is not a usable RPC endpoint",
    () =>
      Effect.gen(function* () {
        // The crash fixture prints the address marker then exits. The
        // spawner's health check is best-effort: depending on race
        // timing the POST may return a bogus url, or surface a 500
        // once the retry budget drains. The invariant we *can*
        // assert is that callers cannot open a parent websocket to
        // the returned url.
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        yield* Effect.gen(function* () {
          const r = yield* postRaw(url, samplePayload(CRASH_FIXTURE_TS_URL));
          if (r.status !== 200) {
            return { unusable: true } as const;
          }
          const usable = yield* canOpenWebSocket(new URL("/parent", r.body));
          return { unusable: !usable } as const;
        }).pipe(
          Effect.flatMap((r) =>
            r.unusable
              ? Effect.void
              : Effect.fail(new Error("endpoint was still usable")),
          ),
          // Mirrors the original `for (let i = 0; i < 4 && !failed; i++)`
          // loop: up to 4 retries spaced 250ms apart.
          Effect.retry({
            schedule: Schedule.spaced(Duration.millis(250)),
            times: 4,
          }),
        );
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );

  it.live(
    "a /logs subscriber receives sidecar stdout and stderr as ndjson",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const client = yield* HttpClient.HttpClient;

        // Subscribe BEFORE spawning (headers received = subscription
        // registered server-side) — with a subscriber connected, the
        // spawner must route sidecar output here instead of its console.
        const response = yield* client.get(new URL(LOGS_PATH, url).toString());
        const collector = yield* response.stream.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map(
            (line) => JSON.parse(line) as { channel: string; line?: string },
          ),
          // drop heartbeats (no `line`) and any non-fixture noise
          Stream.filter(
            (entry): entry is { channel: string; line: string } =>
              entry.line?.startsWith("fixture-") ?? false,
          ),
          Stream.take(6),
          Stream.runCollect,
          Effect.forkScoped,
        );

        const wsUrl = yield* post(url, samplePayload(LOGS_FIXTURE_TS_URL));
        expect(wsUrl).toMatch(/^ws:\/\//);

        const received = Array.from(
          yield* Fiber.join(collector).pipe(
            Effect.timeout(Duration.seconds(20)),
          ),
        );
        const channels = new Set(received.map((entry) => entry.channel));
        expect(
          received.every((entry) => entry.line.startsWith("fixture-")),
        ).toBe(true);
        expect(channels.has("stdout")).toBe(true);
        expect(channels.has("stderr")).toBe(true);
      }).pipe(Effect.provide(services)),
    { timeout: 60_000 },
  );
});

interface PostResult {
  readonly status: number;
  readonly body: string;
}

const postRaw = (
  url: string,
  body: unknown,
): Effect.Effect<PostResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const req = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setBody(
        HttpBody.text(JSON.stringify(body), "application/json"),
      ),
    );
    const res = yield* client.execute(req);
    const text = yield* res.text;
    return { status: res.status, body: text };
  }).pipe(Effect.orDie);

const post = (
  url: string,
  body: unknown,
): Effect.Effect<string, Error, HttpClient.HttpClient> =>
  postRaw(url, body).pipe(
    Effect.flatMap((r) =>
      r.status === 200
        ? Effect.succeed(r.body)
        : Effect.fail(new Error(`spawn POST failed: ${r.status} ${r.body}`)),
    ),
  );

const echoWebSocket = (
  rpcUrl: string,
  msg: string,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    yield* openWebSocket(new URL("/parent", rpcUrl));
    // Sessions carry their stack environment (real clients — the
    // RpcProviderProxy — always send one; a session without it is an error).
    const sessionUrl = new URL(rpcUrl);
    sessionUrl.searchParams.set(
      SESSION_ENV_PARAM,
      encodeSessionEnvironment({
        alchemyContext: {
          dotAlchemy: "/tmp/.alchemy",
          dev: true,
          adopt: false,
        },
        stack: { name: "test", stage: "dev" },
      }),
    );
    return yield* Effect.promise(async () => {
      // Cast through `unknown`: comparing capnweb's deeply-recursive Stub
      // type against RpcStub<RpcProxyApi> exceeds the compiler's
      // instantiation depth (TS2589/TS2321).
      const stub = newWebSocketRpcSession(
        sessionUrl.toString(),
      ) as unknown as RpcStub<RpcProxyApi>;
      const provider = await stub.getProvider("Test.Echo");
      const handlers = unwrapRpcHandlers(provider as any) as {
        echo: (m: string) => Effect.Effect<string>;
      };
      return await Effect.runPromise(handlers.echo(msg));
    });
  }).pipe(Effect.scoped);
