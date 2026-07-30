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

// Ride out 403 blips (`Forbidden`) from scoped-token propagation on the
// test's own out-of-band verification calls.
const getWebhook = (accountId: string) =>
  stream.getWebhook({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string) =>
  getWebhook(accountId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "WebhookNotDeleted" } as const)),
    // An unconfigured webhook surfaces as `WebhookNotFound` (Cloudflare
    // error code 10003) — that's the success condition here.
    Effect.catchTag("WebhookNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WebhookNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// The Stream webhook is an account-level singleton, so the whole
// lifecycle lives in one sequential test to avoid the tests fighting
// over the single slot.
test.provider(
  "configure, update, and delete the account webhook",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const webhook = yield* stack.deploy(
        Cloudflare.Stream.Webhook("Notifications", {
          notificationUrl: "https://example.com/hooks/stream",
        }),
      );

      expect(webhook.accountId).toEqual(accountId);
      expect(webhook.notificationUrl).toEqual(
        "https://example.com/hooks/stream",
      );
      expect(Redacted.value(webhook.secret)).toBeTruthy();

      const live = yield* getWebhook(accountId);
      expect(live.notificationUrl).toEqual("https://example.com/hooks/stream");

      // Update the URL in place — PUT is a true upsert.
      const updated = yield* stack.deploy(
        Cloudflare.Stream.Webhook("Notifications", {
          notificationUrl: "https://example.com/hooks/stream-v2",
        }),
      );

      expect(updated.notificationUrl).toEqual(
        "https://example.com/hooks/stream-v2",
      );

      const observed = yield* getWebhook(accountId);
      expect(observed.notificationUrl).toEqual(
        "https://example.com/hooks/stream-v2",
      );

      // Redeploying identical props is a no-op.
      const noop = yield* stack.deploy(
        Cloudflare.Stream.Webhook("Notifications", {
          notificationUrl: "https://example.com/hooks/stream-v2",
        }),
      );
      expect(noop.notificationUrl).toEqual(
        "https://example.com/hooks/stream-v2",
      );

      yield* stack.destroy();

      yield* expectGone(accountId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account-level singleton): the account has at most
// one Stream webhook, so `list()` reads that single slot and returns a
// one-element array when configured or `[]` when unset — exactly mirroring
// `read`. This is read-only and runs without the Stream subscription
// entitlement (mutating the webhook is covered by the gated lifecycle test
// above, which fails with the typed Cloudflare `StreamSubscriptionRequired`
// error code 10010 on un-entitled accounts).
test.provider(
  "list enumerates the account Stream webhook",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Stream.Webhook);
      const all = yield* provider.list();

      // Account singleton: zero or one webhook, each well-typed Attributes
      // for the ambient account.
      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeLessThanOrEqual(1);
      for (const webhook of all) {
        expect(webhook.accountId).toEqual(accountId);
        expect(typeof webhook.notificationUrl).toEqual("string");
        expect(Redacted.isRedacted(webhook.secret)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
