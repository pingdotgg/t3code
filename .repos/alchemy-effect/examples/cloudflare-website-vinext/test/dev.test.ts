import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  profile: process.env.ALCHEMY_PROFILE,
  dev: true,
});
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll(destroy(Stack));

test(
  "native vinext development serves bindings and hot reload",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
    const home = yield* Test.getWhenReady(String(url)).pipe(
      Effect.flatMap((response) => response.text),
    );
    expect(home).toContain("Hello from vinext on Cloudflare!");
    const api = yield* Test.getWhenReady(`${url}/api/hello`);
    expect(yield* api.json).toEqual({
      message: "Hello from vinext on Cloudflare!",
      noteCount: 0,
    });
    for (const route of [
      "/static",
      "/isr",
      "/use-cache",
      "/notes",
      "/robots.txt",
    ]) {
      expect((yield* Test.getWhenReady(`${url}${route}`)).status).toBe(200);
    }
    expect((yield* Test.getWhenReady(`${url}/admin`)).status).toBe(403);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const page = yield* path.fromFileUrl(
      new URL("../app/page.tsx", import.meta.url),
    );
    const source = yield* fs.readFileString(page);
    const marker = "Updated by the vinext development test";
    yield* Effect.acquireUseRelease(
      fs.writeFileString(
        page,
        source.replace('title="SSR"', `title="${marker}"`),
      ),
      () =>
        Test.getWhenReady(String(url)).pipe(
          Effect.flatMap((response) => response.text),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            times: 20,
            until: (body) => body.includes(marker),
          }),
          Effect.tap((body) =>
            Effect.sync(() => expect(body).toContain(marker)),
          ),
        ),
      () => fs.writeFileString(page, source).pipe(Effect.orDie),
    );
  }),
  { timeout: 120_000 },
);
