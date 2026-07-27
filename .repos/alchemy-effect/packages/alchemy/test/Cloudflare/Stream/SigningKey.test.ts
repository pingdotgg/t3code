import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as stream from "@distilled.cloud/cloudflare/stream";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * True when the key with the given id is listed on the account. The list
 * endpoint returns `result: null` (not `[]`) when there are no keys.
 * Rides out 403 blips (`Forbidden`) from token propagation.
 */
const keyListed = (accountId: string, keyId: string) =>
  stream.getKey({ accountId }).pipe(
    Effect.map((res) => (res.result ?? []).some((k) => k.id === keyId)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, keyId: string) =>
  keyListed(accountId, keyId).pipe(
    Effect.flatMap((listed) =>
      listed
        ? Effect.fail({ _tag: "SigningKeyNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "SigningKeyNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create and delete a signing key",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const key = yield* stack.deploy(
        Cloudflare.Stream.SigningKey("PlaybackKey", {}),
      );

      expect(key.keyId).toBeTruthy();
      expect(key.accountId).toEqual(accountId);
      // The key material is only returned at creation time — it must be
      // captured in the attributes.
      expect(Redacted.value(key.pem)).toBeTruthy();
      expect(Redacted.value(key.jwk)).toBeTruthy();

      expect(yield* keyListed(accountId, key.keyId)).toBe(true);

      // Redeploying is a no-op — same key, same material preserved.
      const noop = yield* stack.deploy(
        Cloudflare.Stream.SigningKey("PlaybackKey", {}),
      );
      expect(noop.keyId).toEqual(key.keyId);
      expect(Redacted.value(noop.pem)).toEqual(Redacted.value(key.pem));

      yield* stack.destroy();

      yield* expectGone(accountId, key.keyId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed signing key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(
        Cloudflare.Stream.SigningKey("ListKey", {}),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Stream.SigningKey,
      );
      const all = yield* provider.list();

      expect(all.some((k) => k.keyId === key.keyId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
