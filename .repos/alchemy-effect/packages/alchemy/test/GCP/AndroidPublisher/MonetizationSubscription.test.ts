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

const waitUntilGone = (appId: string, productId: string) =>
  androidpublisher
    .getMonetizationSubscriptions({
      packageName: appId,
      productId,
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

test.provider(
  "getMonetizationSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.getMonetizationSubscriptions({
          packageName: probePackageName,
          productId: "alchemy_missing_sub",
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
  "createMonetizationSubscriptions without Play access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.createMonetizationSubscriptions({
          packageName: probePackageName,
          productId: "alchemy_probe_sub",
          "regionsVersion.version": "2025/01",
          body: {
            packageName: probePackageName,
            productId: "alchemy_probe_sub",
            listings: [{ languageCode: "en-US", title: "Alchemy Probe" }],
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
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidPublisher.MonetizationSubscription(
            "Premium",
            {
              packageName: packageName!,
              listings: [{ languageCode: "en-US", title: "Premium" }],
            },
          );
        }),
      );

      expect(created.productId.length).toBeGreaterThan(0);
      expect(created.packageName).toEqual(packageName);
      expect(created.listings?.[0]?.title).toEqual("Premium");

      const fetched = yield* androidpublisher.getMonetizationSubscriptions({
        packageName: created.packageName,
        productId: created.productId,
      });
      expect(fetched.productId).toEqual(created.productId);
      expect(fetched.listings?.[0]?.title).toEqual("Premium");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidPublisher.MonetizationSubscription(
            "Premium",
            {
              packageName: created.packageName,
              productId: created.productId,
              listings: [{ languageCode: "en-US", title: "Premium Plus" }],
            },
          );
        }),
      );

      expect(updated.productId).toEqual(created.productId);
      expect(updated.listings?.[0]?.title).toEqual("Premium Plus");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.packageName, created.productId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);
