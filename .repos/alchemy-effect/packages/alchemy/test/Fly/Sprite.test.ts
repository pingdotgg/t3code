import * as sprites from "@distilled.cloud/fly-io/sprites";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Box from "./fixtures/sprite.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  sprites.getSprite({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "SpritesNotEnabled"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const fetchSpriteJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.fail(new Error(`sprite returned ${res.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 20,
    }),
    Effect.map((value) => value as { ok: boolean; text?: string }),
  );

test.provider(
  "listSprites returns sprites",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const listed = yield* sprites.listSprites({});
      expect(Array.isArray(listed.sprites)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "list enumerates alchemy-owned sprites",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Fly.Sprite);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, serve, exec, checkpoint, and delete a sprite",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Box;
        }),
      );

      expect(deployed.spriteId).toEqual(expect.any(String));
      expect(deployed.spriteId.length).toBeGreaterThan(0);
      expect(deployed.name).toEqual(expect.any(String));
      expect(deployed.name.length).toBeGreaterThan(0);
      expect(deployed.url).toEqual(expect.any(String));
      expect(deployed.url).toContain("sprites.app");
      expect(["cold", "warm", "running"]).toContain(deployed.status);
      expect(deployed.urlAuth).toEqual("public");
      expect(deployed.code.hash).toEqual(expect.any(String));
      expect(deployed.code.hash.length).toBeGreaterThan(0);

      const fetched = yield* sprites.getSprite({
        name: deployed.name,
      });
      expect(fetched.name).toEqual(deployed.name);
      expect(fetched.url_settings?.auth).toEqual("public");

      const provider = yield* Provider.findProvider(Fly.Sprite);
      const all = yield* provider.list();
      const found = all.find((sprite) => sprite.name === deployed.name);
      expect(found).toBeDefined();
      expect(found?.urlAuth).toEqual("public");

      const body = yield* fetchSpriteJson(deployed.url);
      expect(body.ok).toEqual(true);

      const echoed = yield* sprites.execCommand({
        name: deployed.name,
        cmd: ["echo", "sprite-exec"],
      });
      expect(echoed.exit_code ?? 0).toEqual(0);
      expect(echoed.stdout ?? "").toContain("sprite-exec");

      const events = yield* sprites.createCheckpoint({
        name: deployed.name,
        comment: "alchemy-test",
      });
      expect(Array.isArray(events)).toBe(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
