import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic HMAC material. Never logged.
const HMAC_A: ReadonlyArray<number> = Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 3) % 256,
);
const HMAC_B: ReadonlyArray<number> = Array.from(
  { length: 32 },
  (_, i) => (i * 11 + 5) % 256,
);

const waitUntilGone = (appName: string, secretName: string) =>
  machines
    .getSecretKey({
      app_name: appName,
      secret_name: secretName,
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

/**
 * Ungated probe: hit listSecretKeys without KMS entitlement so the
 * distilled tag stays pinned. A missing app is `NotFound` when the token
 * can use KMS; otherwise the typed entitlement tag is asserted.
 */
test.provider(
  "listSecretKeys probe asserts a typed tag",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        machines.listSecretKeys({
          app_name: "alchemy-kms-probe-missing",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(["NotFound", "Forbidden"]).toContain(result.failure._tag);
      }
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, update, and delete a secret key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Signing", {
            app,
            type: "hs256",
            value: HMAC_A,
          });
          return { app, key };
        }),
      );

      expect(created.key.appName).toEqual(created.app.appName);
      expect(created.key.name).toEqual(expect.any(String));
      expect(created.key.name.length).toBeGreaterThan(0);
      expect(created.key.type).toEqual("hs256");

      const fetched = yield* machines.getSecretKey({
        app_name: created.key.appName,
        secret_name: created.key.name,
      });
      expect(fetched.name).toEqual(created.key.name);
      expect(fetched.type).toEqual("hs256");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Signing", {
            app,
            type: "hs256",
            value: HMAC_B,
          });
          return { app, key };
        }),
      );

      expect(updated.key.appName).toEqual(created.key.appName);
      expect(updated.key.name).toEqual(created.key.name);
      expect(updated.key.type).toEqual("hs256");

      const refetched = yield* machines.getSecretKey({
        app_name: updated.key.appName,
        secret_name: updated.key.name,
      });
      expect(refetched.name).toEqual(updated.key.name);

      yield* stack.destroy();

      const keyGone = yield* waitUntilGone(
        created.key.appName,
        created.key.name,
      );
      expect(keyGone).toEqual("gone");
      const appGone = yield* waitAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "generate a nacl_sign key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("Generated", {
            app,
            type: "nacl_sign",
          });
          return { app, key };
        }),
      );

      expect(created.key.type).toEqual("nacl_sign");
      expect(created.key.publicKey).toEqual(expect.any(String));

      const fetched = yield* machines.getSecretKey({
        app_name: created.key.appName,
        secret_name: created.key.name,
      });
      expect(fetched.type).toEqual("nacl_sign");
      expect(fetched.public_key).toEqual(created.key.publicKey);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.key.appName, created.key.name);
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
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("ReplaceKey", {
            app,
            type: "nacl_sign",
          });
          return { app, key };
        }),
      );

      const nextName =
        created.key.name.slice(0, -1) +
        (created.key.name.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("ReplaceKey", {
            app,
            name: nextName,
            type: "nacl_sign",
          });
          return { app, key };
        }),
      );

      expect(replaced.key.name).toEqual(nextName);
      expect(replaced.key.name).not.toEqual(created.key.name);
      expect(replaced.key.appName).toEqual(created.key.appName);

      const fetched = yield* machines.getSecretKey({
        app_name: replaced.key.appName,
        secret_name: replaced.key.name,
      });
      expect(fetched.name).toEqual(replaced.key.name);

      const oldGone = yield* waitUntilGone(
        created.key.appName,
        created.key.name,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.key.appName,
        replaced.key.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed secret key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          const key = yield* Fly.SecretKey("ListKey", {
            app,
            type: "nacl_sign",
          });
          return { app, key };
        }),
      );

      const provider = yield* Provider.findProvider(Fly.SecretKey);
      const all = yield* provider.list();
      const found = all.find(
        (key) =>
          key.appName === deployed.key.appName &&
          key.name === deployed.key.name,
      );
      expect(found).toBeDefined();
      expect(found?.type).toEqual(deployed.key.type);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.key.appName,
        deployed.key.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
