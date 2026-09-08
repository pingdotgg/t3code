import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("Site", {
            enableSubdomains: true,
          });
        }),
      );

      expect(created.appId).toEqual(expect.any(String));
      expect(created.appName).toEqual(expect.any(String));
      expect(created.appName.length).toBeGreaterThan(0);
      expect(created.appName.length).toBeLessThanOrEqual(30);
      expect(created.appName).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.url).toEqual(`https://${created.appName}.fly.dev`);
      expect(created.orgSlug).toEqual(expect.any(String));

      const fetched = yield* machines.getApp({
        app_name: created.appName,
      });
      expect(fetched.name).toEqual(created.appName);
      expect(fetched.id).toEqual(created.appId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("Site", {
            enableSubdomains: false,
          });
        }),
      );

      expect(updated.appId).toEqual(created.appId);
      expect(updated.appName).toEqual(created.appName);
      expect(updated.url).toEqual(created.url);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("ReplaceSite");
        }),
      );

      const nextName =
        created.appName.slice(0, -1) +
        (created.appName.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("ReplaceSite", {
            name: nextName,
          });
        }),
      );

      expect(replaced.appName).toEqual(nextName);
      expect(replaced.appName).not.toEqual(created.appName);
      expect(replaced.url).toEqual(`https://${nextName}.fly.dev`);

      const fetched = yield* machines.getApp({
        app_name: replaced.appName,
      });
      expect(fetched.name).toEqual(replaced.appName);

      const oldGone = yield* waitUntilGone(created.appName);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("ListSite");
        }),
      );

      const provider = yield* Provider.findProvider(Fly.App);
      const all = yield* provider.list();
      const found = all.find((app) => app.appName === deployed.appName);
      expect(found).toBeDefined();
      expect(found?.appId).toEqual(deployed.appId);
      expect(found?.url).toEqual(deployed.url);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
