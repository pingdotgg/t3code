import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as intel from "@distilled.cloud/cloudflare/intel";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Custom indicator feeds require the account to be approved as a
// Cloudforce One feed provider. On the standard testing account
// `POST /accounts/{id}/intel/indicator-feeds` fails with HTTP 403
// "Account does not have permission to create a feed" — surfaced as the
// typed `IndicatorFeedsNotEntitled` error. The full lifecycle tests below
// are gated behind an entitled account supplied via env; the probe test
// always runs and pins the typed tags.
//
// NOTE: Cloudflare exposes NO delete endpoint for indicator feeds — the
// provider adopts same-named feeds across runs (deterministic names), so
// the entitled lifecycle re-uses one feed instead of leaking.
const entitled = !!process.env.CLOUDFLARE_TEST_INTEL_FEEDS;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
// `IndicatorFeedNotFound` also matches 403 (Cloudflare answers 403 for
// missing feeds), so only retry the cross-cutting Forbidden tag.
const getFeed = (accountId: string, feedId: number) =>
  intel.getIndicatorFeed({ accountId, feedId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Deterministic name — feeds cannot be deleted, so every run of this suite
// adopts the same feed instead of leaking a new one.
const FEED_NAME = "alchemy-intel-test-feed";

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed IndicatorFeedsNotEntitled error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account is not a feed provider — the distilled create
      // call must fail with the typed entitlement tag. Reads on the same
      // account succeed (and show no feeds), proving the gate is on
      // creation, not on the API token.
      const error = yield* intel
        .createIndicatorFeed({
          accountId,
          name: "alchemy-intel-entitlement-probe",
          description: "entitlement probe",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("IndicatorFeedsNotEntitled");

      const list = yield* intel.listIndicatorFeeds({ accountId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
      expect(list.result).toEqual([]);

      // A feed that does not exist surfaces as the typed
      // `IndicatorFeedNotFound` (Cloudflare misuses HTTP 403 with a
      // "does not exist" message for missing feeds).
      const notFound = yield* intel
        .getIndicatorFeed({ accountId, feedId: 99999999 })
        .pipe(Effect.flip);
      expect(notFound._tag).toEqual("IndicatorFeedNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account collection). Enumeration is NOT gated by
// the feed-provider entitlement (only creation is), so this runs on the
// standard testing account and returns a well-typed (typically empty) array.
// On an unentitled account the account simply owns no feeds.
test.provider(
  "list returns a well-typed array of indicator feeds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Intel.IndicatorFeed,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Every element is the exact `read` Attributes shape.
      for (const feed of all) {
        expect(typeof feed.feedId).toEqual("number");
        expect(feed.accountId).toBeTruthy();
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Requires a Cloudforce One feed-provider account to create the feed under
// test; unlock with CLOUDFLARE_TEST_INTEL_FEEDS=1. Asserts the deployed feed
// is present in the exhaustively-paginated list().
test.provider.skipIf(!entitled)(
  "list enumerates the deployed indicator feed",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const feed = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("ListFeed", {
          name: FEED_NAME,
          description: "alchemy intel list feed",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Intel.IndicatorFeed,
      );
      const all = yield* provider.list();

      const found = all.find((f) => f.feedId === feed.feedId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.name).toEqual(FEED_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Requires a Cloudforce One feed-provider account — unentitled accounts fail with
// the typed IndicatorFeedsNotEntitled (HTTP 403). Unlock with CLOUDFLARE_TEST_INTEL_FEEDS=1.
test.provider.skipIf(!entitled)(
  "create (or adopt), verify out-of-band, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const feed = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("TestFeed", {
          name: FEED_NAME,
          description: "alchemy intel lifecycle feed",
        }),
      );

      expect(feed.feedId).toBeGreaterThan(0);
      expect(feed.accountId).toEqual(accountId);
      expect(feed.name).toEqual(FEED_NAME);
      // Documented defaults.
      expect(feed.isAttributable).toEqual(false);
      expect(feed.isDownloadable).toEqual(false);
      expect(feed.isPublic).toEqual(false);

      const live = yield* getFeed(accountId, feed.feedId);
      expect(live.name).toEqual(FEED_NAME);

      // In-place update: description + visibility flags, same id.
      const updated = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("TestFeed", {
          name: FEED_NAME,
          description: "alchemy intel lifecycle feed v2",
          isAttributable: true,
          isDownloadable: true,
        }),
      );
      expect(updated.feedId).toEqual(feed.feedId);
      expect(updated.description).toEqual("alchemy intel lifecycle feed v2");
      expect(updated.isAttributable).toEqual(true);
      expect(updated.isDownloadable).toEqual(true);

      const liveUpdated = yield* getFeed(accountId, feed.feedId);
      expect(liveUpdated.description).toEqual(
        "alchemy intel lifecycle feed v2",
      );
      expect(liveUpdated.isAttributable).toEqual(true);

      // No-op redeploy keeps the same feed.
      const noop = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("TestFeed", {
          name: FEED_NAME,
          description: "alchemy intel lifecycle feed v2",
          isAttributable: true,
          isDownloadable: true,
        }),
      );
      expect(noop.feedId).toEqual(feed.feedId);

      // Destroy is a documented no-op (no delete API) — the feed must
      // still exist afterwards, and a fresh deploy adopts it back under
      // the same id instead of creating a duplicate.
      yield* stack.destroy();
      const orphan = yield* getFeed(accountId, feed.feedId);
      expect(orphan.id).toEqual(feed.feedId);

      const adopted = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("TestFeed", {
          name: FEED_NAME,
          description: "alchemy intel lifecycle feed v2",
          isAttributable: true,
          isDownloadable: true,
        }),
      );
      expect(adopted.feedId).toEqual(feed.feedId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Requires a Cloudflare feed-provider account (typed IndicatorFeedsNotEntitled otherwise);
// unlock with CLOUDFLARE_TEST_INTEL_FEEDS=1 (+ CLOUDFLARE_TEST_INTEL_CONSUMER_ACCOUNT for the grant step).
test.provider.skipIf(!entitled)(
  "uploads a STIX2 snapshot and grants/revokes a consumer permission",
  (stack) =>
    Effect.gen(function* () {
      const consumer = process.env.CLOUDFLARE_TEST_INTEL_CONSUMER_ACCOUNT;

      yield* stack.destroy();

      const snapshot = JSON.stringify({
        type: "bundle",
        id: "bundle--3fbf63f2-7e2d-4d5a-9b4b-7f4a5d2f9c01",
        objects: [
          {
            type: "indicator",
            spec_version: "2.1",
            id: "indicator--a932fcc6-e032-476c-826f-cb970a5a1ade",
            created: "2024-01-01T00:00:00.000Z",
            modified: "2024-01-01T00:00:00.000Z",
            pattern: "[domain-name:value = 'malicious.example.com']",
            pattern_type: "stix",
            valid_from: "2024-01-01T00:00:00Z",
          },
        ],
      });

      const feed = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("SnapshotFeed", {
          name: FEED_NAME,
          description: "alchemy intel snapshot feed",
          snapshot,
        }),
      );
      expect(feed.snapshotHash).toBeTruthy();

      // Re-deploying the identical snapshot is a no-op (same hash).
      const noop = yield* stack.deploy(
        Cloudflare.Intel.IndicatorFeed("SnapshotFeed", {
          name: FEED_NAME,
          description: "alchemy intel snapshot feed",
          snapshot,
        }),
      );
      expect(noop.feedId).toEqual(feed.feedId);
      expect(noop.snapshotHash).toEqual(feed.snapshotHash);

      if (consumer) {
        const grant = yield* stack.deploy(
          Cloudflare.Intel.IndicatorFeedPermission("ConsumerGrant", {
            feedId: feed.feedId,
            accountTag: consumer,
          }),
        );
        expect(grant.feedId).toEqual(feed.feedId);
        expect(grant.accountTag).toEqual(consumer);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
