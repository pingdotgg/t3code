import { unwrapRpcHandlers } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import {
  layerServer,
  RpcSpawner,
  type RpcSpawnPayload,
} from "@/Local/RpcSpawner.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  assertPidExited,
  canOpenWebSocket,
  isAlive,
  openWebSocket,
  pidListeningOn,
} from "./fixtures/process-effect.ts";

const FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();
const CRASH_FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-crash.ts",
  import.meta.url,
).toString();

const samplePayload = (
  serverEntryUrl: string,
  stackName = "test",
): RpcSpawnPayload => ({
  serverEntryUrl,
  alchemyContext: {
    dotAlchemy: "/tmp/.alchemy",
    dev: true,
    adopt: false,
  },
  stack: { name: stackName, stage: "dev" },
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
    "caches the child by payload: a second POST returns the same url",
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
    "distinct payloads spawn distinct children with distinct urls",
    () =>
      Effect.gen(function* () {
        const url = yield* RpcSpawner.useSync((spawner) => spawner.url);
        const a = yield* post(url, samplePayload(FIXTURE_TS_URL, "stack-a"));
        const b = yield* post(url, samplePayload(FIXTURE_TS_URL, "stack-b"));
        expect(a).not.toBe(b);
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
    return yield* Effect.promise(async () => {
      // Cast through `unknown`: comparing capnweb's deeply-recursive Stub
      // type against RpcStub<RpcProxyApi> exceeds the compiler's
      // instantiation depth (TS2589/TS2321).
      const stub = newWebSocketRpcSession(
        rpcUrl,
      ) as unknown as RpcStub<RpcProxyApi>;
      const provider = await stub.getProvider("Test.Echo");
      const handlers = unwrapRpcHandlers(provider as any) as {
        echo: (m: string) => Effect.Effect<string>;
      };
      return await Effect.runPromise(handlers.echo(msg));
    });
  }).pipe(Effect.scoped);
