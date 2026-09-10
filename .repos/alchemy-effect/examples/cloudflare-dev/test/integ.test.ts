import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import Stack, { SECRETS_STORE_VALUE } from "../alchemy.run.ts";
import type { Message } from "../src/AsyncWorker.ts";
import { WORKFLOW_SECRET_VALUE } from "../src/NotifyWorkflow.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.flatMap(
      Effect.fn(function* (outputs) {
        const {
          asyncWorker,
          effectWorker,
          mediaWorker,
          tailWorker,
          inboxWorker,
          liveKvNamespaceId,
          secretsStoreId,
          secretsSecretId,
        } = outputs;
        assert(typeof asyncWorker === "string");
        assert(typeof effectWorker === "string");
        assert(typeof mediaWorker === "string");
        assert(typeof tailWorker === "string");
        assert(typeof inboxWorker === "string");
        assert(typeof liveKvNamespaceId === "string");
        assert(typeof secretsStoreId === "string");
        assert(typeof secretsSecretId === "string");
        const hyperdrive = (outputs as { hyperdrive?: string }).hyperdrive;
        yield* Effect.forEach(
          [asyncWorker, effectWorker, mediaWorker, tailWorker, inboxWorker],
          (url) =>
            HttpClient.get(url).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.spaced("250 millis"),
                  Schedule.recurs(40),
                ]),
              }),
            ),
        );
        return {
          asyncWorker,
          effectWorker,
          mediaWorker,
          tailWorker,
          inboxWorker,
          liveKvNamespaceId,
          secretsStoreId,
          secretsSecretId,
          hyperdrive,
        };
      }),
    ),
  ),
  { timeout: 300_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

class NotYet extends Data.TaggedError("NotYet")<{ status?: number }> {}

/**
 * GET a route, retrying while it serves a non-200 — used for routes whose
 * first request does heavy lazy work (launching Chrome, warming sharp).
 */
const getJsonReady = (
  url: string | URL,
  {
    times = 10,
    spaced = "2 seconds",
  }: { times?: number; spaced?: `${number} ${"millis" | "seconds"}` } = {},
) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(url);
    if (res.status !== 200) {
      return yield* Effect.fail(new NotYet({ status: res.status }));
    }
    return yield* res.json;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotYet",
      schedule: Schedule.max([Schedule.spaced(spaced), Schedule.recurs(times)]),
    }),
  );

/** 8x4 solid red PNG (checked-in fixture — never generated at test time). */
const PNG_RED_8X4 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC",
    "base64",
  ),
);

/**
 * Find a persisted `.eml` under the local email storage dir whose content
 * carries `needle`. The simulator writes relative to the process cwd, so
 * check both the example dir and the current cwd.
 */
class EmlNotFound extends Data.TaggedError("EmlNotFound")<{}> {}
const findEmlContaining = (needle: string) =>
  Effect.sync(() => {
    const candidates = [
      path.resolve(import.meta.dirname, "..", ".alchemy", "local", "email"),
      path.resolve(process.cwd(), ".alchemy", "local", "email"),
    ];
    for (const dir of candidates) {
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".eml")) continue;
        const content = fs.readFileSync(path.join(dir, name), "utf8");
        if (content.includes(needle)) return content;
      }
    }
    return undefined;
  }).pipe(
    Effect.flatMap((content) =>
      content === undefined
        ? Effect.fail(new EmlNotFound({}))
        : Effect.succeed(content),
    ),
    Effect.retry({
      while: (e) => e._tag === "EmlNotFound",
      schedule: Schedule.max([
        Schedule.spaced("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  );

test(
  "deploys all workers with URLs",
  Effect.gen(function* () {
    const { asyncWorker, effectWorker, mediaWorker, tailWorker, inboxWorker } =
      yield* stack;

    // Local dev proxy URLs — proof no cloud deploy ran for the workers.
    for (const url of [
      asyncWorker,
      effectWorker,
      mediaWorker,
      tailWorker,
      inboxWorker,
    ]) {
      expect(url).toBeString();
      expect(url).toMatch(/^http:\/\/localhost:\d+/);
    }
  }),
);

/**
 * AsyncWorker exports a default fetch handler that calls the `Counter`
 * Durable Object's `increment()` and returns `Hello, world! <n>`.
 *
 * Hitting the worker twice exercises the DO end-to-end and proves
 * persistent state across requests — if the DO binding is missing or
 * the class export is wrong, the first request fails outright.
 */
test(
  "AsyncWorker increments the Counter Durable Object across requests",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;

    const first = yield* HttpClient.get(new URL("/counter", asyncWorker));
    expect(first.status).toBe(200);
    const firstBody = yield* first.text;
    const firstMatch = firstBody.match(/^Hello, world! (\d+)$/);
    expect(firstMatch).not.toBeNull();
    const firstCount = Number(firstMatch![1]);

    const second = yield* HttpClient.get(new URL("/counter", asyncWorker));
    expect(second.status).toBe(200);
    const secondBody = yield* second.text;
    const secondMatch = secondBody.match(/^Hello, world! (\d+)$/);
    expect(secondMatch).not.toBeNull();
    const secondCount = Number(secondMatch![1]);

    expect(secondCount).toBe(firstCount + 1);
  }),
);

/**
 * Under `dev: true` the R2 bucket is emulated by the local provider and the
 * `r2_bucket` binding is served by the local workerd R2 simulator — no cloud
 * bucket is ever created.
 */
test(
  "AsyncWorker reads and writes the local R2 bucket",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/r2", asyncWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { text: string; keys: string[] };
    expect(body.text).toBe("hello from r2");
    expect(body.keys).toContain("hello.txt");
  }),
);

/**
 * Same for D1: the database is a local `dev:` row and queries run against
 * the local workerd D1 simulator (DO SQLite).
 */
test(
  "AsyncWorker queries the local D1 database",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/d1", asyncWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { text: string | null };
    expect(body.text).toBe("hello from d1");
  }),
);

test(
  "AsyncWorker serves assets",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/", asyncWorker));
    expect(response.status).toBe(200);
    const body = yield* response.text;
    expect(body).toMatch("<h1>Hello, world!</h1>");
  }),
);

test(
  "AsyncWorker receives bindings, including variables and secrets",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/env", asyncWorker));
    expect(response.status).toBe(200);
    const body = yield* response.json;
    expect(body).toMatchObject({
      MY_SECRET: "my-secret-abc123",
      MY_VARIABLE: "my-variable-abc123",
      COUNTER: {},
    });
  }),
);

/**
 * `env: { PUBLIC_URL: Cloudflare.Worker.URL }` lowers the `self_url`
 * sentinel to a plain-text binding holding the worker's own URL. Under the
 * local provider (this suite runs with `dev: true`) that URL is the dev
 * proxy's address, resolved before workerd starts. The binding value has no
 * trailing slash; the stack's URL output does — normalize before comparing.
 */
test(
  "AsyncWorker receives its own URL via env: { PUBLIC_URL: Worker.URL }",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/env", asyncWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { PUBLIC_URL: string };
    expect(body.PUBLIC_URL).toBe(asyncWorker.replace(/\/$/, ""));
  }),
);

/**
 * The Effect-native form: `yield* Cloudflare.Worker.URL` at init attaches
 * the `self_url` binding and returns a deferred accessor the handler reads
 * at request time.
 */
test(
  "EffectWorker reads its own URL via yield* Worker.URL",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/url", effectWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { url: string };
    expect(body.url).toBe(effectWorker.replace(/\/$/, ""));
  }),
);

test(
  "AsyncWorker sends and receives messages on the queue",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const body = { text: "hello", sentAt: Date.now() };
    yield* HttpClient.post(new URL("/queue/send", asyncWorker), {
      body: yield* HttpBody.json(body),
    }).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const message = yield* HttpClient.get(
      new URL("/queue/messages", asyncWorker),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((res) => res.json),
      Effect.map(cast<Schema.Json, Array<Message>>),
      Effect.map((messages) =>
        messages.find((m) => m.body.sentAt === body.sentAt),
      ),
      Effect.filterOrFail(
        (message) => message !== undefined,
        () => ({ _tag: "MessageNotFound" }) as const,
      ),
      Effect.retry({
        while: (error) => error._tag === "MessageNotFound",
        schedule: Schedule.max([
          Schedule.spaced("250 millis"),
          Schedule.recurs(25),
        ]),
      }),
    );
    expect(message).toMatchObject({
      id: expect.any(String),
      body,
    });
  }),
  { timeout: 10_000 },
);

/**
 * EffectWorker binds a KV namespace via `Cloudflare.KV.ReadWriteNamespace(KV)`
 * and returns the result of `kv.list()` as JSON. A successful response
 * proves the Effect-style binding wired the runtime SDK and the
 * `WorkerEnvironment` service was provisioned for the fetch handler.
 */
test(
  "EffectWorker returns a KV list result via the Effect KV binding",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(effectWorker);
    expect(response.status).toBe(200);

    const body = (yield* response.json) as {
      keys: Array<{ name: string }>;
      list_complete: boolean;
    };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(typeof body.list_complete).toBe("boolean");
  }),
);

test(
  "EffectWorker sends and receives messages on the queue",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    const body = { text: "hello", sentAt: Date.now() };
    yield* HttpClient.post(new URL("/queue/send", effectWorker), {
      body: yield* HttpBody.json(body),
    }).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const message = yield* HttpClient.get(
      new URL("/queue/messages", effectWorker),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((res) => res.json),
      Effect.map(cast<Schema.Json, Array<Message>>),
      Effect.map((messages) =>
        messages.find((m) => m.body.sentAt === body.sentAt),
      ),
      Effect.filterOrFail(
        (message) => message !== undefined,
        () => ({ _tag: "MessageNotFound" }) as const,
      ),
      Effect.retry({
        while: (error) => error._tag === "MessageNotFound",
        schedule: Schedule.max([
          Schedule.spaced("250 millis"),
          Schedule.recurs(25),
        ]),
      }),
    );
    expect(message).toMatchObject({
      id: expect.any(String),
      body,
    });
  }),
  { timeout: 10_000 },
);

/**
 * Both workers import `./modules/wasm-example.wasm`, which exports a
 * single `add(a: number, b: number): number` function. Hitting `/wasm`
 * instantiates the module and returns `add(3, 4)` as JSON, proving that
 * the bundler ships the wasm asset to workerd and that runtime
 * `WebAssembly.instantiate` works for both the raw async-handler and
 * Effect-style entrypoints.
 */
test(
  "AsyncWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", asyncWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);

test(
  "EffectWorker /wasm instantiates the wasm module and returns add(3, 4)",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const response = yield* HttpClient.get(new URL("/wasm", effectWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { result: number };
    expect(body.result).toBe(7);
  }),
);

/**
 * Cache API: the local runtime ships an always-on `caches.default`
 * simulator persisted under `.alchemy/local`. A per-run key keeps the
 * first request a deterministic miss even though the storage survives
 * across runs.
 */
test(
  "AsyncWorker caches responses with the Cache API (miss then hit)",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const key = crypto.randomUUID();

    const first = (yield* (yield* HttpClient.get(
      new URL(`/cache?key=${key}`, asyncWorker),
    )).json) as { hit: boolean; body: string };
    expect(first.hit).toBe(false);
    expect(first.body).toBe("cached-body");

    const second = (yield* (yield* HttpClient.get(
      new URL(`/cache?key=${key}`, asyncWorker),
    )).json) as { hit: boolean; body: string };
    expect(second.hit).toBe(true);
    expect(second.body).toBe("cached-body");
  }),
);

/**
 * Rate limit binding: THROTTLE allows 2 requests per 10s per key. The local
 * runtime implements real throttling (not a stub), so the third call with
 * the same (per-run) key observes `success: false`.
 */
test(
  "AsyncWorker rate limit binding throttles the third call",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const key = crypto.randomUUID();
    const url = new URL(`/ratelimit?key=${key}`, asyncWorker);

    const outcomes: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const res = yield* HttpClient.get(url);
      expect(res.status).toBe(200);
      const body = (yield* res.json) as { success: boolean };
      outcomes.push(body.success);
    }
    expect(outcomes).toEqual([true, true, false]);
  }),
);

/**
 * Version metadata binding: locally stubbed with a random `id` (and empty
 * `tag`), matching the production binding's shape.
 */
test(
  "AsyncWorker exposes version metadata",
  Effect.gen(function* () {
    const { asyncWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/version", asyncWorker));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { id: string };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  }),
);

/**
 * Service binding (worker → worker): AsyncWorker's `/service` route calls
 * the Effect-native worker's `/url` route through `env.SERVICE.fetch` — no
 * public hop. In local dev this resolves through the dev registry, which
 * may pick a fresh peer up asynchronously — hence the bounded retry.
 */
test(
  "AsyncWorker calls EffectWorker through a service binding",
  Effect.gen(function* () {
    const { asyncWorker, effectWorker } = yield* stack;
    const body = (yield* getJsonReady(new URL("/service", asyncWorker))) as {
      url: string;
    };
    expect(body.url).toBe(effectWorker.replace(/\/$/, ""));
  }),
  { timeout: 60_000 },
);

/**
 * tailConsumers: AsyncWorker lists TailWorker as a tail consumer, so every
 * invocation delivers a trace batch (outcome + console logs) to its `tail()`
 * handler, which records into KV. Each poll re-invokes the producer so an
 * early dropped batch (registry still warming) doesn't strand the test.
 */
test(
  "TailWorker receives AsyncWorker's trace batches",
  Effect.gen(function* () {
    const { asyncWorker, tailWorker } = yield* stack;

    const batches = yield* Effect.gen(function* () {
      yield* HttpClient.get(new URL("/tail-ping", asyncWorker)).pipe(
        Effect.flatMap((res) => res.text),
        Effect.orDie,
      );
      const res = yield* HttpClient.get(new URL("/events", tailWorker));
      if (res.status !== 200) return [] as string[];
      const body = (yield* res.json) as { batches?: unknown };
      return Array.isArray(body.batches) ? (body.batches as string[]) : [];
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (batches): boolean =>
          batches.some((batch) => batch.includes("cloudflare-dev-tail-marker")),
        times: 20,
      }),
    );

    const batch = batches.find((b) => b.includes("cloudflare-dev-tail-marker"));
    expect(batch).toBeDefined();
    const items = JSON.parse(batch!) as {
      logs?: { message?: unknown[] }[];
    }[];
    expect(
      items.some((item) =>
        item.logs?.some((log) =>
          log.message?.includes("cloudflare-dev-tail-marker"),
        ),
      ),
    ).toBe(true);
  }),
  { timeout: 60_000 },
);

/**
 * Cron trigger: EffectWorker registers `cron("* * * * *", ...)` at init.
 * Locally the fire is driven on demand via the `/cdn-cgi/handler/scheduled`
 * trigger route (never wait for the minute boundary); the handler records
 * `controller.scheduledTime` into a DO which `/cron/times` exposes.
 */
test(
  "EffectWorker cron handler fires via the scheduled trigger route",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;

    const scheduledTime = Date.now();
    const trigger = yield* HttpClient.post(
      new URL(
        `/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}&time=${scheduledTime}`,
        effectWorker,
      ),
    );
    expect(trigger.status).toBe(200);
    expect(yield* trigger.text).toBe("ok");

    const times = yield* Effect.gen(function* () {
      const res = yield* HttpClient.get(new URL("/cron/times", effectWorker));
      if (res.status !== 200) return [] as number[];
      const body = (yield* res.json) as { times?: unknown };
      return Array.isArray(body.times) ? (body.times as number[]) : [];
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (times): boolean => times.includes(scheduledTime),
        times: 20,
      }),
    );
    expect(times).toContain(scheduledTime);
  }),
  { timeout: 60_000 },
);

/**
 * secret_key binding: workerd imports the checked-in HMAC material as a
 * non-extractable CryptoKey; the route signs and verifies a message with it.
 */
test(
  "EffectWorker signs and verifies with the secret_key binding",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    const response = yield* HttpClient.get(
      new URL("/secret-key?message=hello", effectWorker),
    );
    expect(response.status).toBe(200);
    const body = (yield* response.json) as {
      verified: boolean;
      algorithm: string;
      extractable: boolean;
      signatureBase64: string;
    };
    expect(body.verified).toBe(true);
    expect(body.algorithm).toBe("HMAC");
    // Bound keys are never extractable; the local lowering matches.
    expect(body.extractable).toBe(false);
    expect(body.signatureBase64.length).toBeGreaterThan(0);
  }),
);

/**
 * Analytics Engine: `writeDataPoint` is accepted and discarded in local dev
 * (Miniflare parity) — succeeding without a throw IS the documented local
 * behavior.
 */
test(
  "EffectWorker writes an Analytics Engine data point (local no-op)",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/analytics", effectWorker));
    expect(response.status).toBe(200);
    expect((yield* response.json) as { ok: boolean }).toEqual({ ok: true });
  }),
);

/**
 * Secrets Store: the store + secret are local `dev:` rows and the
 * `secrets_store_secret` binding round-trips the exact seeded value.
 */
test(
  "MediaWorker reads the Secrets Store secret",
  Effect.gen(function* () {
    const { mediaWorker, secretsStoreId, secretsSecretId } = yield* stack;

    // Locally emulated — no cloud store/secret was created.
    expect(secretsStoreId).toMatch(/^dev:/);
    expect(secretsSecretId).toMatch(/^dev:/);

    const body = (yield* (yield* HttpClient.get(
      new URL("/secret", mediaWorker),
    )).json) as { value: string };
    expect(body.value).toBe(SECRETS_STORE_VALUE);
  }),
);

/**
 * send_email: locally the message is persisted as an `.eml` under
 * `.alchemy/local/email` instead of being delivered; the simulator
 * synthesizes a production-shaped Message-ID.
 */
test(
  "MediaWorker sends email; the .eml lands in local storage",
  Effect.gen(function* () {
    const { mediaWorker } = yield* stack;
    const marker = crypto.randomUUID();

    const res = yield* HttpClient.get(
      new URL(`/email/send?marker=${marker}`, mediaWorker),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toMatch(/^<[A-Za-z0-9]{36}@example\.com>$/);

    const eml = yield* findEmlContaining(`marker:${marker}`);
    expect(eml).toContain("From: sender <sender@example.com>");
    expect(eml).toContain(`Message-ID: <${marker}@example.com>`);
  }),
  { timeout: 60_000 },
);

/**
 * Inbound email: POST a raw MIME message to the worker's
 * `/cdn-cgi/handler/email` trigger route. The `email()` handler records it
 * into KV (asserted via `/email/received`); a `reject-me` subject calls
 * `setReject`, which the sender observes as a 400.
 */
test(
  "InboxWorker email() handler accepts and rejects inbound email",
  Effect.gen(function* () {
    const { inboxWorker } = yield* stack;
    const marker = crypto.randomUUID();
    const from = "someone@example.com";
    const to = "someone-else@example.com";
    const triggerUrl = new URL(
      `/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      inboxWorker,
    );
    const mime = (subject: string) =>
      [
        `From: someone <${from}>`,
        `To: someone else <${to}>`,
        `Subject: ${subject}`,
        `Message-ID: <incoming-${marker}@example.com>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain",
        "",
        "This is a random email body.",
      ].join("\n");

    // Accepted.
    const okRes = yield* HttpClient.post(triggerUrl, {
      body: HttpBody.text(mime(`accept-me:${marker}`)),
    });
    const okText = yield* okRes.text;
    if (okRes.status !== 200) {
      // The trigger route surfaces handler errors as a 500 with the stack.
      throw new Error(`email trigger failed (${okRes.status}): ${okText}`);
    }
    expect(okText).toBe("Worker successfully processed email");

    const received = (yield* (yield* HttpClient.get(
      new URL("/email/received", inboxWorker),
    )).json) as Array<{ from: string; to: string; subject: string }>;
    const record = received.find((r) => r.subject === `accept-me:${marker}`);
    expect(record).toMatchObject({ from, to });

    // Rejected via setReject → the sender sees a 400 with the reason.
    const rejectRes = yield* HttpClient.post(triggerUrl, {
      body: HttpBody.text(mime(`reject-me:${marker}`)),
    });
    expect(rejectRes.status).toBe(400);
    expect(yield* rejectRes.text).toBe(
      "Worker rejected email with the following reason: I don't like this email",
    );
  }),
  { timeout: 60_000 },
);

/**
 * Browser Rendering: renders an inline HTML page through
 * `@cloudflare/puppeteer` against the locally launched Chrome. The FIRST
 * run on a machine downloads Chrome into the shared wrangler cache, which
 * can take minutes — hence the generous bounded retry + timeout.
 */
test(
  "MediaWorker renders a page through the browser binding",
  Effect.gen(function* () {
    const { mediaWorker } = yield* stack;
    const body = (yield* getJsonReady(new URL("/browser/title", mediaWorker), {
      times: 30,
      spaced: "5 seconds",
    })) as { title: string; heading: string };
    expect(body.title).toBe("Cloudflare Dev");
    expect(body.heading).toBe("Hello from the local browser");
  }),
  { timeout: 240_000 },
);

/**
 * Images: `info()` + `transform().output()` served locally by sharp.
 * The transform result is re-inspected through `info()` to prove real pixel
 * work happened (8x4 contain-fit to width 4 → 4x2).
 */
test(
  "MediaWorker transforms an image through the images binding",
  Effect.gen(function* () {
    const { mediaWorker } = yield* stack;

    const info = (yield* (yield* HttpClient.post(
      new URL("/images/info", mediaWorker),
      { body: HttpBody.uint8Array(PNG_RED_8X4) },
    )).json) as { format: string; width: number; height: number };
    expect(info.format).toBe("image/png");
    expect(info.width).toBe(8);
    expect(info.height).toBe(4);

    const transformRes = yield* HttpClient.post(
      new URL("/images/transform?width=4", mediaWorker),
      { body: HttpBody.uint8Array(PNG_RED_8X4) },
    );
    expect(transformRes.status).toBe(200);
    const outputBytes = new Uint8Array(yield* transformRes.arrayBuffer);
    // PNG magic bytes.
    expect(Array.from(outputBytes.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);

    const outputInfo = (yield* (yield* HttpClient.post(
      new URL("/images/info", mediaWorker),
      { body: HttpBody.uint8Array(outputBytes) },
    )).json) as { format: string; width: number; height: number };
    expect(outputInfo.width).toBe(4);
    expect(outputInfo.height).toBe(2);
  }),
  { timeout: 60_000 },
);

/**
 * HYBRID — per-binding `Alchemy.remote()`: `IMAGES_REMOTE` proxies to
 * the REAL Images service while the worker (and every other binding) stays
 * local. Requires real Cloudflare credentials, which this suite already has
 * (the state store is remote).
 */
test(
  "MediaWorker images binding with Alchemy.remote() hits the real service",
  Effect.gen(function* () {
    const { mediaWorker } = yield* stack;
    const info = (yield* Effect.gen(function* () {
      const res = yield* HttpClient.post(
        new URL("/images/info-remote", mediaWorker),
        { body: HttpBody.uint8Array(PNG_RED_8X4) },
      );
      if (res.status !== 200) {
        return yield* Effect.fail(new NotYet({ status: res.status }));
      }
      return yield* res.json;
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "NotYet",
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    )) as { format: string; width: number; height: number };
    expect(info.format).toBe("image/png");
    expect(info.width).toBe(8);
    expect(info.height).toBe(4);
  }),
  { timeout: 120_000 },
);

/**
 * Stream: upload video bytes through the binding, read details back, then
 * fetch the watch URL served by the local stream router middleware.
 */
test(
  "MediaWorker uploads and watches a video through the stream binding",
  Effect.gen(function* () {
    const { mediaWorker } = yield* stack;
    const videoBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

    const video = (yield* (yield* HttpClient.post(
      new URL("/stream/upload", mediaWorker),
      { body: HttpBody.uint8Array(videoBytes) },
    )).json) as {
      id: string;
      readyToStream: boolean;
      status: { state: string };
      size: number;
      creator: string | null;
    };
    expect(video.id).toBeTruthy();
    expect(video.readyToStream).toBe(true);
    expect(video.status.state).toBe("ready");
    expect(video.size).toBe(videoBytes.byteLength);
    expect(video.creator).toBe("alchemy");

    const details = (yield* (yield* HttpClient.get(
      new URL(`/stream/details?id=${video.id}`, mediaWorker),
    )).json) as { id: string; size: number };
    expect(details.id).toBe(video.id);
    expect(details.size).toBe(videoBytes.byteLength);

    // The watch route is served by the stream router middleware in front of
    // the worker.
    const watchRes = yield* HttpClient.get(
      new URL(`/cdn-cgi/mf/stream/${video.id}/watch`, mediaWorker),
    );
    expect(watchRes.status).toBe(200);
    const watched = new Uint8Array(yield* watchRes.arrayBuffer);
    expect(Array.from(watched)).toEqual(Array.from(videoBytes));

    // Clean up so re-runs stay tidy.
    const deleted = (yield* (yield* HttpClient.get(
      new URL(`/stream/delete?id=${video.id}`, mediaWorker),
    )).json) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
  }),
  { timeout: 60_000 },
);

/**
 * HYBRID — `Alchemy.remote()`: LiveKV opted out of local emulation, so its
 * id is a REAL namespace id (no `dev:` marker) and the binding round-trip
 * from the local worker lands in the real cloud namespace.
 */
test(
  "Alchemy.remote() KV namespace is live while the worker stays local",
  Effect.gen(function* () {
    const { asyncWorker, liveKvNamespaceId } = yield* stack;

    // A real cloud namespace id — the `dev:` marker means "emulated" and
    // must be absent here.
    expect(liveKvNamespaceId).not.toMatch(/^dev:/);

    const key = crypto.randomUUID();
    const value = crypto.randomUUID();
    const put = (yield* getJsonReady(
      new URL(`/kv-live?key=${key}&value=${value}`, asyncWorker),
      { times: 10, spaced: "2 seconds" },
    )) as { value: string | null };
    expect(put.value).toBe(value);

    const got = (yield* (yield* HttpClient.get(
      new URL(`/kv-live?key=${key}`, asyncWorker),
    )).json) as { value: string | null };
    expect(got.value).toBe(value);
  }),
  { timeout: 60_000 },
);

interface WorkflowStatus {
  status: string;
  output?: { text?: string; secret?: string; ts?: number };
  error?: { name: string; message: string } | null;
}

/**
 * Start a `NotifyWorkflow` instance through `workerUrl` and poll its status
 * until the instance reaches a terminal state. Asserts the workflow ran the
 * KV roundtrip task (`Processed: <message>`) and resolved the plantime-bound
 * `Alchemy.Secret` at runtime (`output.secret === WORKFLOW_SECRET_VALUE`).
 */
const exerciseWorkflow = (workerUrl: string, label: string) =>
  Effect.gen(function* () {
    const roomId = `${label}-${Math.random().toString(36).slice(2, 10)}`;

    const startResponse = yield* HttpClient.post(
      new URL(`/workflow/start/${roomId}`, workerUrl),
    );
    expect(startResponse.status).toBe(200);
    const { instanceId } = (yield* startResponse.json) as {
      instanceId: string;
    };
    expect(instanceId).toBeString();

    const statusUrl = new URL(`/workflow/status/${instanceId}`, workerUrl);
    const fetchStatus = HttpClient.get(statusUrl).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as unknown as WorkflowStatus),
    );
    const status = yield* fetchStatus.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s: WorkflowStatus) =>
          s.status === "complete" || s.status === "errored",
        times: 60,
      }),
    );

    expect(status.error).toBeFalsy();
    expect(status.status).toBe("complete");
    expect(status.output?.secret).toBe(WORKFLOW_SECRET_VALUE);
    expect(status.output?.text).toBe("Processed: hello from workflow");
  });

/**
 * EffectWorker `/workflow/start/:roomId` kicks off `NotifyWorkflow`, which
 * does a KV roundtrip task and resolves the `WORKFLOW_SECRET` `Alchemy.Secret`
 * at runtime. The status route surfaces the workflow output so we can assert
 * the workflow actually executed end-to-end (not just that it was scheduled).
 */
test(
  "EffectWorker drives NotifyWorkflow to completion with secret + KV roundtrip",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    yield* exerciseWorkflow(effectWorker, "effect");
  }),
  { timeout: 60_000 },
);

test(
  "EffectWorker fetches a URL in a sandbox",
  Effect.gen(function* () {
    const { effectWorker } = yield* stack;
    const response = yield* HttpClient.get(new URL("/sandbox", effectWorker));
    expect(response.status).toBe(200);
    const body = yield* response.text;
    // The container echoes its `GREETING` env var, proving env vars flow
    // through to the container (via the application config on a live deploy,
    // and via `ctx.container.start({ env })` in local dev).
    expect(body).toBe("Hello from Sandbox container! GREETING=hello-from-env");
  }),
  { timeout: 60_000 },
);

/**
 * Hyperdrive: local dev is a passthrough to the Connection's `dev` origin,
 * which must be a REAL reachable Postgres. Gated behind
 * `HYPERDRIVE_DEV_URL` (see src/HyperdriveWorker.ts for a one-liner Docker
 * setup); without it the stack omits the worker and this test skips.
 */
test.skipIf(!process.env.HYPERDRIVE_DEV_URL)(
  "HyperdriveWorker queries Postgres through the hyperdrive binding",
  Effect.gen(function* () {
    const { hyperdrive } = yield* stack;
    assert(typeof hyperdrive === "string");

    const body = (yield* getJsonReady(new URL("/query", hyperdrive), {
      times: 15,
      spaced: "2 seconds",
    })) as { row: { sum: number; db: string } };
    expect(body.row.sum).toBe(2);
    expect(body.row.db.length).toBeGreaterThan(0);
  }),
  { timeout: 120_000 },
);
