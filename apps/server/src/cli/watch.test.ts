import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off - the cross-process proof needs a real HTTP server and real child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  decodeWatchConfig,
  redactWebhookUrl,
  runWatch,
  watchLocked,
  watchOnce,
  type WatchConfig,
} from "./watch.ts";

interface RecordedRequest {
  readonly url: string;
  readonly key: string | undefined;
  readonly body: Record<string, unknown>;
}

/** Fake webhook endpoint: `statuses` is consumed per POST; 0 means a network error. */
const makeHarness = (statuses: Array<number> = []) => {
  const requests: Array<RecordedRequest> = [];
  // The fake server dedupes by Idempotency-Key like the real one: a repeat is dropped.
  const seen = new Set<string>();
  const fresh: Array<string> = [];
  const duplicates: Array<string> = [];
  const client = HttpClient.make((request) => {
    if (request.body._tag !== "Uint8Array") return Effect.die("unexpected body");
    const idempotencyKey = request.headers["idempotency-key"] ?? "";
    if (seen.has(idempotencyKey)) duplicates.push(idempotencyKey);
    else {
      seen.add(idempotencyKey);
      fresh.push(idempotencyKey);
    }
    requests.push({
      url: request.url,
      key: request.headers["idempotency-key"],
      body: JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
    });
    const status = statuses.shift() ?? 200;
    return status === 0
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  return { requests, fresh, duplicates, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "t3-watch-" });
    return yield* body(dir).pipe(
      Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
    );
  });

const WEBHOOK = "https://relay.example/hooks/secret-token";

const makeConfig = (dir: string, overrides: Partial<WatchConfig> = {}): WatchConfig => ({
  name: "lease",
  webhookUrl: WEBHOOK,
  probes: [{ kind: "file", name: "lease", path: `${dir}/lease`, notify: ["present"] }],
  retry: { attempts: 3, baseDelayMs: 0 },
  ...overrides,
});

/** Runs one pass, then advances the test clock so later passes see time move on. */
const pass = (config: WatchConfig, statePath: string) =>
  watchOnce(config, statePath).pipe(Effect.tap(() => TestClock.adjust(Duration.minutes(5))));

const readCursor = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(path)) as {
      instanceId: string;
      seq: number;
      state: Record<string, string>;
      sentDeadlines: Array<string>;
      pending: { key: string } | null;
    };
  });

const listNames = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fs.readDirectory(dir)).map((entry) => path.basename(entry)).toSorted();
  });

describe("t3 watch", () => {
  it.effect(
    "sends nothing while unchanged and exactly one keyed POST per allow-listed change",
    () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const harness = makeHarness();
          const statePath = `${dir}/state.json`;
          const config = makeConfig(dir);
          const run = pass(config, statePath).pipe(Effect.provide(harness.layer));

          for (let index = 0; index < 10; index += 1) yield* run;
          assert.strictEqual(harness.requests.length, 0);

          yield* fs.writeFileString(`${dir}/lease`, "x");
          const stuck = yield* run;
          assert.isTrue(Option.isNone(stuck));
          assert.strictEqual(harness.requests.length, 1);
          const [request] = harness.requests;
          const { instanceId } = yield* readCursor(statePath);
          assert.match(instanceId, /^[0-9a-f-]{36}$/);
          assert.strictEqual(request!.key, `lease:${instanceId}:1`);
          assert.strictEqual(request!.url, WEBHOOK);
          assert.deepStrictEqual(
            { ...request!.body, at: undefined },
            {
              watch: "lease",
              instance: instanceId,
              event: "lease:absent->present",
              probe: "lease",
              from: "absent",
              to: "present",
              state: { lease: "present" },
              seq: 1,
              at: undefined,
            },
          );

          for (let index = 0; index < 5; index += 1) yield* run;
          assert.strictEqual(harness.requests.length, 1);
          const cursor = yield* readCursor(statePath);
          assert.deepStrictEqual(cursor.state, { lease: "present" });
          assert.strictEqual(cursor.seq, 1);
          assert.isNull(cursor.pending);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "records non-allow-listed transitions silently and keeps A to B to A to B keys distinct",
    () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const harness = makeHarness();
          const statePath = `${dir}/state.json`;
          const config = makeConfig(dir);
          const run = pass(config, statePath).pipe(Effect.provide(harness.layer));

          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run; // baseline: present, nothing sent
          yield* fs.remove(`${dir}/lease`);
          yield* run; // ->absent is not allow-listed
          assert.strictEqual(harness.requests.length, 0);
          assert.deepStrictEqual((yield* readCursor(statePath)).state, { lease: "absent" });

          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run;
          yield* fs.remove(`${dir}/lease`);
          yield* run;
          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run;
          const { instanceId } = yield* readCursor(statePath);
          assert.deepStrictEqual(
            harness.requests.map((request) => request.key),
            [`lease:${instanceId}:1`, `lease:${instanceId}:2`],
          );
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("sends nothing for the first observation unless notifyInitial is set", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const quiet = makeHarness();
        yield* pass(makeConfig(dir), `${dir}/quiet.json`).pipe(Effect.provide(quiet.layer));
        assert.strictEqual(quiet.requests.length, 0);

        const loud = makeHarness();
        const config = makeConfig(dir, {
          probes: [
            {
              kind: "file",
              name: "lease",
              path: `${dir}/lease`,
              notify: ["present"],
              notifyInitial: true,
            },
          ],
        });
        yield* pass(config, `${dir}/loud.json`).pipe(Effect.provide(loud.layer));
        assert.strictEqual(loud.requests.length, 1);
        assert.strictEqual(loud.requests[0]!.body.from, null);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps a failed event pending and re-sends it with the same key", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer)); // baseline absent
        yield* fs.writeFileString(`${dir}/lease`, "x");

        const down = makeHarness([503, 0, 429]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(down.layer));
        const failed = yield* readCursor(statePath);
        const key = `lease:${failed.instanceId}:1`;
        assert.deepStrictEqual(stuck, Option.some(key));
        assert.strictEqual(down.requests.length, 3);
        assert.strictEqual(failed.pending?.key, key);
        assert.deepStrictEqual(failed.state, { lease: "absent" });

        const up = makeHarness();
        const done = yield* pass(config, statePath).pipe(Effect.provide(up.layer));
        assert.isTrue(Option.isNone(done));
        assert.deepStrictEqual(
          up.requests.map((request) => request.key),
          [key],
        );
        const cleared = yield* readCursor(statePath);
        assert.isNull(cleared.pending);
        assert.deepStrictEqual(cleared.state, { lease: "present" });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("commits one event when a 5xx is followed by a 2xx within the retries", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer));
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const harness = makeHarness([500, 200]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(stuck));
        const cursor = yield* readCursor(statePath);
        const key = `lease:${cursor.instanceId}:1`;
        assert.deepStrictEqual(
          harness.requests.map((request) => request.key),
          [key, key],
        );
        assert.isNull(cursor.pending);
        assert.strictEqual(cursor.seq, 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("drops a 4xx event but keeps the new state so it does not loop", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer));
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const harness = makeHarness([404]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(stuck));
        assert.strictEqual(harness.requests.length, 1);
        const cursor = yield* readCursor(statePath);
        assert.isNull(cursor.pending);
        assert.deepStrictEqual(cursor.state, { lease: "present" });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("fires a missed deadline once and never again", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const statePath = `${dir}/state.json`;
        // TestClock starts at the epoch, so any later ISO time is in the past once adjusted.
        const config = makeConfig(dir, {
          deadlines: [
            {
              name: "lease-by-noon",
              at: "1970-01-01T00:00:10.000Z",
              unless: { probe: "lease", value: "present" },
            },
          ],
        });
        const harness = makeHarness();
        const run = pass(config, statePath).pipe(Effect.provide(harness.layer));
        yield* run; // clock is already past `at` after pass() adjusts, but first pass runs at 0
        yield* run;
        yield* run;
        const deadlineRequests = harness.requests.filter((request) =>
          String(request.body.event).startsWith("deadline_missed:"),
        );
        assert.strictEqual(deadlineRequests.length, 1);
        assert.strictEqual(deadlineRequests[0]!.body.event, "deadline_missed:lease-by-noon");
        const cursor = yield* readCursor(statePath);
        assert.deepStrictEqual(cursor.sentDeadlines, ["lease-by-noon@1970-01-01T00:00:10.000Z"]);

        // A fresh run against the same cursor does not resend.
        const again = makeHarness();
        yield* pass(config, statePath).pipe(Effect.provide(again.layer));
        assert.strictEqual(again.requests.length, 0);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("leaves no temp files behind", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const config = makeConfig(dir, {
          probes: [
            {
              kind: "file",
              name: "lease",
              path: `${dir}/lease`,
              notify: ["*"],
              notifyInitial: true,
            },
          ],
        });
        yield* pass(config, `${dir}/state.json`).pipe(Effect.provide(makeHarness().layer));
        assert.deepStrictEqual(yield* listNames(dir), ["lease", "state.json"]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("gives each state file its own identity even when config names collide", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = makeHarness();
        const config = makeConfig(dir);
        const hostA = `${dir}/a.json`;
        const hostB = `${dir}/b.json`;
        yield* pass(config, hostA).pipe(Effect.provide(harness.layer));
        yield* pass(config, hostB).pipe(Effect.provide(harness.layer));
        yield* fs.writeFileString(`${dir}/lease`, "x");
        yield* pass(config, hostA).pipe(Effect.provide(harness.layer));
        yield* pass(config, hostB).pipe(Effect.provide(harness.layer));

        assert.strictEqual(harness.requests.length, 2);
        assert.strictEqual(harness.fresh.length, 2);
        assert.deepStrictEqual(harness.duplicates, []);
        const [a, b] = [yield* readCursor(hostA), yield* readCursor(hostB)];
        assert.notStrictEqual(a.instanceId, b.instanceId);
        assert.deepStrictEqual(
          new Set(harness.fresh),
          new Set([`lease:${a.instanceId}:1`, `lease:${b.instanceId}:1`]),
        );
        assert.deepStrictEqual(
          new Set(harness.requests.map((request) => request.body.instance)),
          new Set([a.instanceId, b.instanceId]),
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps the instance for the cursor's life and mints a new one when recreated", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = makeHarness();
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        const run = pass(config, statePath).pipe(Effect.provide(harness.layer));

        yield* run;
        const first = yield* readCursor(statePath);
        yield* fs.writeFileString(`${dir}/lease`, "x");
        yield* run;
        yield* fs.remove(`${dir}/lease`);
        yield* run;
        assert.strictEqual((yield* readCursor(statePath)).instanceId, first.instanceId);

        yield* fs.remove(statePath);
        yield* run; // fresh baseline: absent
        const second = yield* readCursor(statePath);
        assert.notStrictEqual(second.instanceId, first.instanceId);
        yield* fs.writeFileString(`${dir}/lease`, "x");
        yield* run;

        // seq restarted at 1 but the keys differ, so the server accepts both as new.
        assert.deepStrictEqual(harness.fresh, [
          `lease:${first.instanceId}:1`,
          `lease:${second.instanceId}:1`,
        ]);
        assert.deepStrictEqual(harness.duplicates, []);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("lets only one of two concurrent in-process passes probe and send", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = makeHarness();
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(harness.layer)); // baseline
        yield* fs.writeFileString(`${dir}/lease`, "x");

        const results = yield* Effect.all(
          [watchLocked(config, statePath), watchLocked(config, statePath)],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(harness.layer));

        assert.strictEqual(harness.requests.length, 1);
        assert.strictEqual(results.filter(Option.isSome).length >= 1, true);
        const cursor = yield* readCursor(statePath);
        assert.strictEqual(cursor.seq, 1);
        assert.isNull(cursor.pending);
        assert.deepStrictEqual(yield* listNames(dir), ["lease", "state.json"]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("re-sends the exact stored key once after a crash left a dead holder's lock", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer)); // baseline
        yield* fs.writeFileString(`${dir}/lease`, "x");
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness([503, 503, 503]).layer));
        const crashed = yield* readCursor(statePath);
        const storedKey = crashed.pending?.key;
        assert.strictEqual(storedKey, `lease:${crashed.instanceId}:1`);

        // A pid far above any real pid on this host stands in for the dead holder.
        yield* fs.writeFileString(
          `${statePath}.lock`,
          JSON.stringify({
            token: "dead-holder",
            pid: 2 ** 22 + 12345,
            hostname: NodeOS.hostname(),
            acquiredAt: 0,
            heartbeatAt: 0,
            staleAfterMs: 120_000,
          }),
        );
        const harness = makeHarness();
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(stuck));
        assert.deepStrictEqual(
          harness.requests.map((request) => request.key),
          [storedKey],
        );
        assert.isNull((yield* readCursor(statePath)).pending);
        assert.deepStrictEqual(yield* listNames(dir), ["lease", "state.json"]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reclaims a lock whose heartbeat is older than its staleness bound", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        yield* TestClock.adjust(Duration.hours(1));
        // Another host, so only the heartbeat age can mark it stale.
        yield* fs.writeFileString(
          `${statePath}.lock`,
          JSON.stringify({
            token: "gone",
            pid: process.pid,
            hostname: `${NodeOS.hostname()}-elsewhere`,
            acquiredAt: 0,
            heartbeatAt: 0,
            staleAfterMs: 120_000,
          }),
        );
        const harness = makeHarness();
        const result = yield* watchLocked(makeConfig(dir), statePath).pipe(
          Effect.provide(harness.layer),
        );
        assert.isTrue(Option.isSome(result));
        assert.deepStrictEqual(yield* listNames(dir), ["state.json"]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("skips without probing or touching the cursor while a live holder owns the lock", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer)); // baseline
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const before = yield* fs.readFileString(statePath);
        const lock = JSON.stringify({
          token: "someone-else",
          pid: process.pid,
          hostname: NodeOS.hostname(),
          acquiredAt: 0,
          heartbeatAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
          staleAfterMs: 120_000,
        });
        yield* fs.writeFileString(`${statePath}.lock`, lock);

        const harness = makeHarness();
        const result = yield* watchLocked(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(result));
        assert.strictEqual(harness.requests.length, 0);
        assert.strictEqual(yield* fs.readFileString(statePath), before);
        assert.strictEqual(yield* fs.readFileString(`${statePath}.lock`), lock);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("stops a looping watcher from writing once another process took its lock", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const configPath = `${dir}/watch.json`;
        yield* fs.writeFileString(`${dir}/lease`, "x");
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({
            ...makeConfig(dir, { retry: { attempts: 1, baseDelayMs: 0 } }),
            probes: [
              {
                kind: "file",
                name: "lease",
                path: `${dir}/lease`,
                notify: ["*"],
                notifyInitial: true,
              },
            ],
            statePath,
          }),
        );
        // While the first POST is in flight, a process on another host takes the lock,
        // as if this watcher had been suspended past its staleness bound.
        const harness = makeHarness([0]);
        const client = HttpClient.make((request) => {
          NodeFS.writeFileSync(
            `${statePath}.lock`,
            JSON.stringify({
              token: "taker",
              pid: 1,
              hostname: "another-host",
              acquiredAt: 0,
              heartbeatAt: Number.MAX_SAFE_INTEGER,
              staleAfterMs: 120_000,
            }),
          );
          return Effect.flatMap(HttpClient.HttpClient, (inner) => inner.execute(request)).pipe(
            Effect.provide(harness.layer),
          );
        });
        const stuck = Promise.withResolvers<void>();
        const skipped = Promise.withResolvers<void>();
        const testConsole = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            if (String(args[0]).includes("another watcher holds")) skipped.resolve();
          },
          error: (...args: ReadonlyArray<unknown>) => {
            if (String(args[0]).includes("still pending")) stuck.resolve();
          },
        } satisfies Console.Console;

        const fiber = yield* runWatch({
          configPath,
          once: false,
          intervalSeconds: Option.none(),
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Console.Console, testConsole),
          Effect.forkChild,
        );
        // The failed first POST leaves its event pending, logged just before the loop sleeps.
        yield* Effect.promise(() => stuck.promise);
        const before = yield* fs.readFileString(statePath);
        yield* fs.remove(`${dir}/lease`);
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Effect.promise(() => skipped.promise);
        yield* Fiber.interrupt(fiber);

        // No retry of the pending event and no new transition: the cursor is untouched.
        assert.strictEqual(harness.requests.length, 1);
        assert.strictEqual(yield* fs.readFileString(statePath), before);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Real processes: the winner holds the lock while its POST is parked, so the
  // loser can only ever see a held lock. The server answers once a process exits.
  it.effect("lets exactly one of two real concurrent --once processes send", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const posts: Array<string> = [];
        let release = () => {};
        const parked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const server = NodeHttp.createServer((request, response) => {
          posts.push(String(request.headers["idempotency-key"]));
          void parked.then(() => response.writeHead(200).end());
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release();
            server.closeAllConnections();
            server.close();
          }),
        ).pipe(Effect.ignore);
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const configPath = `${dir}/config.json`;
        const config = makeConfig(dir, {
          webhookUrl: `http://127.0.0.1:${String(port)}/hooks/x`,
          statePath,
          retry: { attempts: 1, baseDelayMs: 0 },
        });
        yield* fs.writeFileString(configPath, JSON.stringify(config));
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer)); // baseline
        yield* fs.writeFileString(`${dir}/lease`, "x");

        const spawn = () =>
          new Promise<{ code: number | null; out: string }>((resolve, reject) => {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [new URL("../bin.ts", import.meta.url).pathname, "watch", configPath, "--once"],
              {
                env: { ...process.env, T3CODE_HOME: `${dir}/home` },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.on("error", reject);
            child.on("exit", (code) => {
              release(); // whichever exits first is the skipper; unpark the winner's POST
              resolve({ code, out });
            });
          });
        const runs = yield* Effect.promise(() => Promise.all([spawn(), spawn()]));

        assert.deepStrictEqual(
          runs.map((run) => run.code),
          [0, 0],
        );
        assert.strictEqual(posts.length, 1);
        assert.strictEqual(runs.filter((run) => /another watcher holds/.test(run.out)).length, 1);
        const cursor = yield* readCursor(statePath);
        assert.strictEqual(posts[0], `lease:${cursor.instanceId}:1`);
        assert.strictEqual(cursor.seq, 1);
        assert.isNull(cursor.pending);
        assert.deepStrictEqual(
          (yield* listNames(dir)).filter((name) => name !== "home"),
          ["config.json", "lease", "state.json"],
        );
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("turns a command's exit status into a transition without a shell", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const statePath = `${dir}/state.json`;
        const probe = (code: number) =>
          ({
            kind: "command",
            name: "job",
            argv: [process.execPath, "-e", `process.exit(${String(code)})`],
            notify: ["exit:3"],
          }) as const;
        const harness = makeHarness();
        const run = (code: number) =>
          watchOnce(makeConfig(dir, { probes: [probe(code)] }), statePath).pipe(
            Effect.provide(harness.layer),
          );
        yield* run(0);
        yield* run(0);
        assert.strictEqual(harness.requests.length, 0);
        yield* run(3);
        assert.strictEqual(harness.requests.length, 1);
        assert.strictEqual(harness.requests[0]!.body.event, "job:exit:0->exit:3");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("rejects unknown config keys and bad notify values", () =>
    Effect.gen(function* () {
      const base = {
        name: "w",
        webhookUrl: WEBHOOK,
        probes: [{ kind: "file", name: "f", path: "/x", notify: ["present"] }],
      };
      const excess = yield* decodeWatchConfig(JSON.stringify({ ...base, extra: 1 })).pipe(
        Effect.flip,
      );
      assert.strictEqual(excess._tag, "WatchConfigError");
      const badNotify = yield* decodeWatchConfig(
        JSON.stringify({
          ...base,
          probes: [{ kind: "file", name: "f", path: "/x", notify: ["exit:0"] }],
        }),
      ).pipe(Effect.flip);
      assert.match(badNotify.message, /cannot notify on "exit:0"/);
      const fast = yield* decodeWatchConfig(JSON.stringify({ ...base, intervalSeconds: 1 })).pipe(
        Effect.flip,
      );
      assert.strictEqual(fast._tag, "WatchConfigError");
    }),
  );

  it("redacts the webhook token", () => {
    assert.strictEqual(
      redactWebhookUrl("https://relay.example/hooks/abc123?x=1"),
      "https://relay.example/hooks/***",
    );
  });
});
