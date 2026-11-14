import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const requestOnce = (url: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  });

// A fresh workers.dev URL can flap between serving and a 404 (or 5xx) while
// it propagates across the edge, even after a first successful response, so
// ride out those statuses. Assertions on a deliberate 404 use `requestOnce`.
const request = (url: string, init?: RequestInit) =>
  requestOnce(url, init).pipe(
    Effect.flatMap((response) =>
      response.status === 404 || response.status >= 500
        ? Effect.fail(new Error(`${url} answered ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(
  destroy(Stack).pipe(
    Effect.andThen(deploy(Stack)),
    Effect.tap(({ url }) =>
      request(url!).pipe(
        Effect.flatMap((response) =>
          response.status === 200 && response.body.includes("<title>Foldkit App</title>")
            ? Effect.void
            : Effect.fail(new Error("The example has not reached the edge yet")),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
        Effect.timeout("60 seconds"),
      ),
    ),
  ),
  { timeout: 120_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });
const base = Effect.map(stack, ({ url }) => url!.replace(/\/+$/, ""));

test(
  "serves the SPA shell on root and deep links",
  Effect.gen(function* () {
    const url = yield* base;
    for (const path of ["/", "/counter/42"]) {
      const page = yield* request(url + path);
      expect(page.status).toBe(200);
      expect(page.body).toContain('<div id="root"></div>');
      expect(page.body).toContain("<title>Foldkit App</title>");
      expect(page.body).not.toContain("data-foldkit-app");
    }
  }),
  { timeout: 120_000 },
);

test(
  "serves the generated JavaScript and Tailwind stylesheet",
  Effect.gen(function* () {
    const url = yield* base;
    const page = yield* request(url);
    const script = page.body.match(/<script[^>]+src="([^" ]+)"/);
    const style = page.body.match(/<link[^>]+href="([^" ]+\.css)"/);
    expect(script).not.toBeNull();
    expect(style).not.toBeNull();
    const javascript = yield* request(new URL(script![1]!, url).href);
    expect(javascript.status).toBe(200);
    expect(javascript.headers.get("content-type")).toContain("javascript");
    const css = yield* request(new URL(style![1]!, url).href);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.body).toContain(".text-6xl");
  }),
  { timeout: 120_000 },
);
