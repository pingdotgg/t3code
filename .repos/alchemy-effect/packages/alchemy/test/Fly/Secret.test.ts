import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const VALUE_A = Redacted.make("alchemy-secret-a");
const VALUE_B = Redacted.make("alchemy-secret-b");

const waitUntilGone = (appName: string, secretName: string) =>
  machines
    .getSecret({
      app_name: appName,
      secret_name: secretName,
      show_secrets: false,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitAppGone = (appName: string) =>
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
  "create, update, and delete a secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("DbUrl", {
            app,
            value: VALUE_A,
          });
          return { app, secret };
        }),
      );

      expect(created.secret.appName).toEqual(created.app.appName);
      expect(created.secret.name).toEqual(expect.any(String));
      expect(created.secret.name.length).toBeGreaterThan(0);
      expect(created.secret.digest).toEqual(expect.any(String));

      const fetched = yield* machines.getSecret({
        app_name: created.secret.appName,
        secret_name: created.secret.name,
        show_secrets: false,
      });
      expect(fetched.name).toEqual(created.secret.name);
      expect(fetched.digest).toEqual(created.secret.digest);
      expect(fetched.value).toBeUndefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("DbUrl", {
            app,
            value: VALUE_B,
          });
          return { app, secret };
        }),
      );

      expect(updated.secret.appName).toEqual(created.secret.appName);
      expect(updated.secret.name).toEqual(created.secret.name);
      expect(updated.secret.digest).toEqual(expect.any(String));
      expect(updated.secret.digest).not.toEqual(created.secret.digest);

      const refetched = yield* machines.getSecret({
        app_name: updated.secret.appName,
        secret_name: updated.secret.name,
        show_secrets: false,
      });
      expect(refetched.name).toEqual(updated.secret.name);
      expect(refetched.digest).toEqual(updated.secret.digest);
      expect(refetched.digest).not.toEqual(created.secret.digest);
      expect(refetched.value).toBeUndefined();

      yield* stack.destroy();

      const secretGone = yield* waitUntilGone(
        created.secret.appName,
        created.secret.name,
      );
      expect(secretGone).toEqual("gone");
      const appGone = yield* waitAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
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
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("ReplaceSecret", {
            app,
            value: VALUE_A,
          });
          return { app, secret };
        }),
      );

      const nextName =
        created.secret.name.slice(0, -1) +
        (created.secret.name.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("ReplaceSecret", {
            app,
            name: nextName,
            value: VALUE_A,
          });
          return { app, secret };
        }),
      );

      expect(replaced.secret.name).toEqual(nextName);
      expect(replaced.secret.name).not.toEqual(created.secret.name);
      expect(replaced.secret.appName).toEqual(created.secret.appName);

      const fetched = yield* machines.getSecret({
        app_name: replaced.secret.appName,
        secret_name: replaced.secret.name,
        show_secrets: false,
      });
      expect(fetched.name).toEqual(replaced.secret.name);
      expect(fetched.value).toBeUndefined();

      const oldGone = yield* waitUntilGone(
        created.secret.appName,
        created.secret.name,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.secret.appName,
        replaced.secret.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const secret = yield* Fly.Secret("ListSecret", {
            app,
            value: VALUE_A,
          });
          return { app, secret };
        }),
      );

      const provider = yield* Provider.findProvider(Fly.Secret);
      const all = yield* provider.list();
      const found = all.find(
        (secret) =>
          secret.appName === deployed.secret.appName &&
          secret.name === deployed.secret.name,
      );
      expect(found).toBeDefined();
      expect(found?.digest).toEqual(deployed.secret.digest);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.secret.appName,
        deployed.secret.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
