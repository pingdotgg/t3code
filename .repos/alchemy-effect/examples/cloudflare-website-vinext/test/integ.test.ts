import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { getWhenReady, executeWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("5 seconds"),
      ]),
      times: 10,
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  profile: process.env.ALCHEMY_PROFILE,
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

// Pre-deploy cleanup must not close the suite's shared runtime scope.
const stack = beforeAll(
  Effect.sync(Test.defaultStage).pipe(
    Effect.flatMap((stage) => Alchemy.destroy({ stack: Stack, stage })),
    Effect.andThen(deploy(Stack)),
    Effect.tap(Console.log),
  ),
  {
    timeout: 600_000,
  },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return String(url).replace(/\/+$/, "");
});

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(
      url,
      "Hello from vinext on Cloudflare!",
    );
    expect(html).toContain('data-testid="increment"');
  }),
  { timeout: 180_000 },
);

test(
  "serves the static page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(
      `${url}/static`,
      "Prerendered at deploy",
    );
    expect(html).toContain("This page is statically generated.");
  }),
  { timeout: 180_000 },
);

test(
  "serves the cached ISR page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/isr`, "revalidate=30");
    expect(html).toContain('data-testid="isr-time"');
    expect(html).toContain("Refresh cache now");

    const stamp = (body: string) => {
      const match = body.match(
        /data-testid="isr-time"[^>]*>[\s\S]*?<time dateTime="([^"]+)"/,
      );
      return match?.[1]?.trim();
    };
    const first = stamp(html);
    expect(first).toBeTruthy();

    // Second fetch should reuse the seeded / KV-backed ISR entry.
    const again = yield* getBodyWhenReady(`${url}/isr`, "revalidate=30");
    expect(stamp(again)).toBe(first);
  }),
  { timeout: 180_000 },
);

test(
  "serves the use-cache page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/use-cache`, "use cache");
    expect(html).toContain('data-testid="use-cache-cached"');
  }),
  { timeout: 180_000 },
);

test(
  "serves the notes page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/notes`, "Notes");
    expect(html).toContain("Add");
  }),
  { timeout: 180_000 },
);

test(
  "serves the dynamic API route",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/hello`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { message: string; noteCount: number };
    expect(body.message).toBe("Hello from vinext on Cloudflare!");
    expect(body.noteCount).toBeNumber();
  }),
  { timeout: 180_000 },
);

test(
  "blocks /admin with proxy",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/admin`);
    expect(res.status).toBe(403);
    const body = yield* res.text;
    expect(body).toContain("Blocked by proxy");
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);

test(
  "writes and lists a D1 note",
  Effect.gen(function* () {
    const url = yield* base;
    const title = "vinext-d1-note";
    const created = yield* executeWhenReady(
      HttpClientRequest.post(`${url}/api/notes`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ title }),
      ),
    );
    expect(created.status).toBe(201);
    const listed = yield* getWhenReady(`${url}/api/notes`);
    expect(listed.status).toBe(200);
    const body = (yield* listed.json) as {
      notes: Array<{ title: string }>;
    };
    const createdBody = (yield* created.json) as { id: string; title: string };
    expect(body.notes.some((note) => note.title === title)).toBe(true);

    const deleted = yield* executeWhenReady(
      HttpClientRequest.delete(`${url}/api/notes/${createdBody.id}`),
    );
    expect(deleted.status).toBe(204);
    const after = (yield* getWhenReady(`${url}/api/notes`).pipe(
      Effect.flatMap((res) => res.json),
    )) as { notes: Array<{ id: string }> };
    expect(after.notes.some((note) => note.id === createdBody.id)).toBe(false);
    const kv = yield* getWhenReady(`${url}/api/kv/note:${createdBody.id}`);
    const kvBody = (yield* kv.json) as { value: string | null };
    expect(kvBody.value).toBeNull();
  }),
  { timeout: 180_000 },
);

test(
  "round-trips a KV value",
  Effect.gen(function* () {
    const url = yield* base;
    const put = yield* executeWhenReady(
      HttpClientRequest.put(`${url}/api/kv/ping`).pipe(
        HttpClientRequest.bodyText("pong"),
      ),
    );
    expect(put.status).toBe(201);
    const res = yield* getWhenReady(`${url}/api/kv/ping`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string };
    expect(body.value).toBe("pong");
  }),
  { timeout: 180_000 },
);
