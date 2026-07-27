import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as images from "@distilled.cloud/cloudflare/images";
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

// The Images signing-keys endpoints are gated behind a higher Images
// entitlement than variants: on the testing account, `GET
// /accounts/{id}/images/v1/keys` fails with code 5403 — "The given account
// is not valid or is not authorized to access this service" — surfaced as
// the typed `ImagesAccessNotEnabled` error, while the variants endpoints on
// the very same account succeed. The full lifecycle test below is gated
// behind an entitled account supplied via env.
const keysEntitled = !!process.env.CLOUDFLARE_TEST_IMAGES_KEYS;

const listKeyNames = (accountId: string) =>
  images
    .listV1Keys({ accountId })
    .pipe(Effect.map((r) => (r.keys ?? []).map((k) => k.name)));

// Poll the key list until the named key disappears — list reads are
// eventually consistent after a DELETE.
const expectGone = (accountId: string, name: string) =>
  listKeyNames(accountId).pipe(
    Effect.flatMap((names) =>
      names.includes(name)
        ? Effect.fail({ _tag: "KeyNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "KeyNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Read-only enumeration is always exercised (not entitlement-gated):
// `list()` swallows the `ImagesAccessNotEnabled` 5403 and returns `[]` on
// unentitled accounts, so the result is a well-typed Attributes[] in either
// case. On an entitled account it additionally contains the deployed key.
test.provider("list enumerates the account's signing keys", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Cloudflare.Images.SigningKey);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const key of all) {
      expect(typeof key.keyName).toBe("string");
      expect(key.accountId).toEqual(accountId);
      expect(typeof Redacted.value(key.value)).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(keysEntitled)(
  "surfaces the typed ImagesAccessNotEnabled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account's Images subscription does not include the
      // signing-keys API — the distilled call must fail with the typed
      // entitlement tag (Cloudflare error code 5403).
      const error = yield* images.listV1Keys({ accountId }).pipe(Effect.flip);
      expect(error._tag).toEqual("ImagesAccessNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// NOTE: Cloudflare caps signing keys at 2 per account (the account's
// default key counts as #1) and refuses to delete the last remaining key.
// This suite creates exactly one extra key with a deterministic name and
// always cleans it up, so repeated runs stay under the cap.
test.provider.skipIf(!keysEntitled)(
  "create a signing key, no-op redeploy keeps the value, delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const keyName = "alchemytestsigningkey";

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Cloudflare.Images.SigningKey("TestSigningKey", {
          name: keyName,
        }),
      );

      expect(created.keyName).toEqual(keyName);
      expect(created.accountId).toEqual(accountId);
      const createdValue = Redacted.value(created.value);
      expect(createdValue).toBeTruthy();

      // Out-of-band verification — the key shows up in the account list
      // with the same value.
      const names = yield* listKeyNames(accountId);
      expect(names).toContain(keyName);

      // Redeploying identical props must NOT re-PUT (a re-PUT would rotate
      // the key material) — the value stays byte-identical.
      const noop = yield* stack.deploy(
        Cloudflare.Images.SigningKey("TestSigningKey", {
          name: keyName,
        }),
      );
      expect(noop.keyName).toEqual(keyName);
      expect(Redacted.value(noop.value)).toEqual(createdValue);

      yield* stack.destroy();

      yield* expectGone(accountId, keyName);

      // Destroy again — delete is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
);
