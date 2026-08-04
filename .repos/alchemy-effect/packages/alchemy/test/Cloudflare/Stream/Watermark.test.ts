import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as stream from "@distilled.cloud/cloudflare/stream";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * A small, stable, publicly hosted PNG for Cloudflare to download
 * (watermark images must be PNG, <= 2 MiB).
 */
const PNG_URL =
  "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png";

// Ride out 403 blips (`Forbidden`) from scoped-token propagation on the
// test's own out-of-band verification calls.
const getWatermark = (accountId: string, watermarkId: string) =>
  stream.getWatermark({ accountId, identifier: watermarkId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, watermarkId: string) =>
  getWatermark(accountId, watermarkId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "WatermarkNotDeleted" } as const)),
    // A missing watermark surfaces as `WatermarkNotFound` (Cloudflare
    // error code 10003) — that's the success condition here.
    Effect.catchTag("WatermarkNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WatermarkNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create and delete a watermark with default name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const watermark = yield* stack.deploy(
        Cloudflare.Stream.Watermark("DefaultWatermark", {
          url: PNG_URL,
        }),
      );

      expect(watermark.watermarkId).toBeTruthy();
      expect(watermark.accountId).toEqual(accountId);
      expect(watermark.downloadedFrom).toEqual(PNG_URL);
      expect(watermark.position).toEqual("upperRight");
      expect(watermark.opacity).toEqual(1.0);
      expect(watermark.width).toBeGreaterThan(0);

      const live = yield* getWatermark(accountId, watermark.watermarkId);
      expect(live.uid).toEqual(watermark.watermarkId);
      expect(live.name).toEqual(watermark.name);

      yield* stack.destroy();

      yield* expectGone(accountId, watermark.watermarkId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "prop change replaces the watermark (create-only resource)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.Stream.Watermark("ReplaceWatermark", {
          name: "alchemy-stream-wm-replace",
          url: PNG_URL,
        }),
      );

      expect(initial.position).toEqual("upperRight");

      // No update endpoint — changing any prop must replace (new uid).
      const replaced = yield* stack.deploy(
        Cloudflare.Stream.Watermark("ReplaceWatermark", {
          name: "alchemy-stream-wm-replace",
          url: PNG_URL,
          position: "center",
          opacity: 0.5,
        }),
      );

      expect(replaced.watermarkId).not.toEqual(initial.watermarkId);
      expect(replaced.position).toEqual("center");
      expect(replaced.opacity).toEqual(0.5);

      const live = yield* getWatermark(accountId, replaced.watermarkId);
      expect(live.position).toEqual("center");
      expect(live.opacity).toEqual(0.5);

      // The old watermark must be gone after the replacement.
      yield* expectGone(accountId, initial.watermarkId);

      // Redeploying identical props is a no-op (same uid).
      const noop = yield* stack.deploy(
        Cloudflare.Stream.Watermark("ReplaceWatermark", {
          name: "alchemy-stream-wm-replace",
          url: PNG_URL,
          position: "center",
          opacity: 0.5,
        }),
      );
      expect(noop.watermarkId).toEqual(replaced.watermarkId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.watermarkId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account collection): deploy a watermark, then
// enumerate every watermark profile in the account via the provider's
// `list()` and assert the deployed uid is present in the exhaustively
// paginated result.
test.provider(
  "list enumerates the deployed watermark",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.Stream.Watermark("ListWatermark", {
          name: "alchemy-stream-wm-list",
          url: PNG_URL,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Stream.Watermark,
      );
      const all = yield* provider.list();

      expect(all.some((w) => w.watermarkId === deployed.watermarkId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
