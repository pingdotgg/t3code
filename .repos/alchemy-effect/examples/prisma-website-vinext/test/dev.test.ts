import * as Cloud from "alchemy/Prisma";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloud.providers(), dev: true });

test.provider(
  "native vinext development serves routes, environment, and hot reload",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* path.fromFileUrl(new URL("../", import.meta.url));
      const { site } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            site: yield* Cloud.Website.Vinext("Web", {
              rootDir,
              env: { GREETING: "Hello from vinext on Prisma!" },
            }),
          };
        }),
      );
      expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
      const url = String(site.url).replace(/\/+$/, "");
      const home = yield* Test.getWhenReady(url).pipe(
        Effect.flatMap((response) => response.text),
      );
      expect(home).toContain("Hello from vinext on Prisma!");
      const api = yield* Test.getWhenReady(`${url}/api/hello?name=Alchemy`);
      expect(yield* api.json).toEqual({
        name: "Alchemy",
        greeting: "Hello from vinext on Prisma!",
      });
      const robots = yield* Test.getWhenReady(`${url}/robots.txt`);
      expect(yield* robots.text).toContain("User-agent:");
      const isr = yield* Test.getWhenReady(`${url}/isr`);
      expect(yield* isr.text).toContain("ISR");
      const page = path.join(rootDir, "app/page.tsx");
      const source = yield* fs.readFileString(page);
      const marker = "Updated by the vinext development test";
      yield* Effect.acquireUseRelease(
        fs.writeFileString(
          page,
          source.replace("Hello from vinext on Prisma!", marker),
        ),
        () =>
          Test.getWhenReady(url).pipe(
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
      const restored = yield* Test.getWhenReady(url).pipe(
        Effect.flatMap((response) => response.text),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          times: 20,
          until: (body) => !body.includes(marker),
        }),
      );
      expect(restored).toContain("Hello from vinext on Prisma!");
      expect(restored).not.toContain(marker);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
