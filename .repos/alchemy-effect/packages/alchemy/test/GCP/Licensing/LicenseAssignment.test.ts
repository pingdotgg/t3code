import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  customerId,
  logLevel,
  missingUserId,
  runLifecycle,
  productId,
  skuId,
  updateSkuId,
  userId,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "getLicenseAssignments on a missing assignment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        licensing.getLicenseAssignments({
          productId,
          skuId,
          userId: missingUserId,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:licensing", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "insertLicenseAssignments without the licensing scope fails with InsufficientAuthenticationScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        licensing.insertLicenseAssignments({
          productId,
          skuId,
          body: { userId: missingUserId },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:licensing", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a license assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Licensing.LicenseAssignment("Seat", {
            productId,
            skuId,
            userId,
            customerId,
          });
        }),
      );

      expect(created.productId).toEqual(productId);
      expect(created.skuId).toEqual(skuId);
      expect(created.userId.toLowerCase()).toEqual(userId.toLowerCase());
      expect(created.project.length).toBeGreaterThan(0);

      const fetched = yield* licensing.getLicenseAssignments({
        productId: created.productId,
        skuId: created.skuId,
        userId: created.userId,
      });
      expect(fetched.productId).toEqual(productId);
      expect(fetched.skuId).toEqual(skuId);
      expect((fetched.userId ?? "").toLowerCase()).toEqual(
        userId.toLowerCase(),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Licensing.LicenseAssignment("Seat", {
            productId,
            skuId: updateSkuId,
            userId,
            customerId,
          });
        }),
      );

      expect(updated.productId).toEqual(productId);
      expect(updated.userId.toLowerCase()).toEqual(userId.toLowerCase());
      expect(updated.skuId).toEqual(updateSkuId);

      const fetchedUpdate = yield* licensing.getLicenseAssignments({
        productId: updated.productId,
        skuId: updated.skuId,
        userId: updated.userId,
      });
      expect(fetchedUpdate.skuId).toEqual(updateSkuId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone({
        productId: updated.productId,
        skuId: updated.skuId,
        userId: updated.userId,
      });
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:licensing", "live"], timeout: 90_000 },
);
