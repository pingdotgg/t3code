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
    // The Worker reaches the edge before its assets do: wait for both the
    // hydrating home page and a second prerendered route.
    Effect.tap(({ url }) =>
      Effect.all([request(url!), request(url!.replace(/\/+$/, "") + "/about")]).pipe(
        Effect.flatMap(([home, about]) =>
          home.status === 200 &&
          home.body.includes("Statically generated home") &&
          home.body.includes("<script") &&
          about.status === 200
            ? Effect.void
            : Effect.fail(new Error("The example has not reached the edge yet")),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 25 }),
        Effect.timeout("60 seconds"),
      ),
    ),
  ),
  { timeout: 120_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });
const base = Effect.map(stack, ({ url }) => url!.replace(/\/+$/, ""));

test(
  "serves prerendered routes and hydration data",
  Effect.gen(function* () {
    const url = yield* base;
    for (const [path, heading] of [
      ["/", "Statically generated home"],
      ["/about", "Statically generated about page"],
    ]) {
      const page = yield* request(url + path + "?count=7");
      expect(page.status).toBe(200);
      expect(page.body).toContain(heading!);
      expect(page.body).toContain("data-foldkit-app");
      expect(page.body).toContain("data-foldkit-build");
      const head = yield* request(url + path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
    }
    expect((yield* requestOnce(url + "/not-prerendered")).status).toBe(404);
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
    expect(css.body).toContain(".text-4xl");
  }),
  { timeout: 120_000 },
);
