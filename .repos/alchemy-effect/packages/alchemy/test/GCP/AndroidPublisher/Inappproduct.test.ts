import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  packageName,
  probePackageName,
  missingTag,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (appId: string, sku: string) =>
  androidpublisher.getInappproducts({ packageName: appId, sku }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getInappproducts on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.getInappproducts({
          packageName: probePackageName,
          sku: "alchemy_missing_iap",
        }),
      );
      expect(error._tag).toEqual(missingTag);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "insertInappproducts without Play access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.insertInappproducts({
          packageName: probePackageName,
          autoConvertMissingPrices: true,
          body: {
            packageName: probePackageName,
            sku: "alchemy_probe_iap",
            defaultLanguage: "en-US",
            purchaseType: "managedUser",
            defaultPrice: { currency: "USD", priceMicros: "990000" },
            listings: { "en-US": { title: "Alchemy Probe" } },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an in-app product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidPublisher.Inappproduct("GemPack", {
            packageName: packageName!,
            listings: { "en-US": { title: "Gem pack" } },
          });
        }),
      );

      expect(created.sku.length).toBeGreaterThan(0);
      expect(created.packageName).toEqual(packageName);
      expect(created.listings?.["en-US"]?.title).toEqual("Gem pack");

      const fetched = yield* androidpublisher.getInappproducts({
        packageName: created.packageName,
        sku: created.sku,
      });
      expect(fetched.sku).toEqual(created.sku);
      expect(fetched.listings?.["en-US"]?.title).toEqual("Gem pack");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidPublisher.Inappproduct("GemPack", {
            packageName: created.packageName,
            sku: created.sku,
            listings: { "en-US": { title: "Starter gem pack" } },
          });
        }),
      );

      expect(updated.sku).toEqual(created.sku);
      expect(updated.listings?.["en-US"]?.title).toEqual("Starter gem pack");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.packageName, created.sku);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);
