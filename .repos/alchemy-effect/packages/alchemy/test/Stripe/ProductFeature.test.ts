import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetEntitlementsFeatures,
  GetProductFeatures,
  GetProductFeature,
  CreateEntitlementsFeature,
  UpdateEntitlementsFeature,
  type EntitlementsFeature as StripeEntitlementsFeature,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const isMissing = isMissingStripeResource;

const waitUntilGone = (product: string, id: string) =>
  GetProductFeatures({ product, limit: 100 }).pipe(
    Effect.map((response) =>
      response.data.some((feature) => feature.id === id)
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/**
 * Entitlements Features cannot be hard-deleted and cannot be updated once
 * inactive. Create (or reuse an active row) via distilled so this suite is
 * not blocked by the sibling resource's deactivate-only lifecycle.
 */
const ensureFeature = (lookupKey: string, name: string) =>
  Effect.gen(function* () {
    const active = yield* GetEntitlementsFeatures({
      lookup_key: lookupKey,
      archived: false,
      limit: 1,
    });
    if (active.data[0] !== undefined) return active.data[0];
    return yield* CreateEntitlementsFeature({
      lookup_key: lookupKey,
      name,
      metadata: { [Stripe.alchemyMetadataKeys.stack]: "ProductFeatureTest" },
    }).pipe(
      Effect.catchIf(
        (e) => e._tag === "InvalidRequestError",
        (e) =>
          GetEntitlementsFeatures({
            lookup_key: lookupKey,
            archived: false,
            limit: 1,
          }).pipe(
            Effect.flatMap((res) =>
              res.data[0] !== undefined
                ? Effect.succeed(res.data[0])
                : Effect.fail(e),
            ),
          ),
      ),
    );
  });

const archiveFeature = (id: string) =>
  UpdateEntitlementsFeature({ id, active: false }).pipe(
    Effect.catchIf(isMissing, () => Effect.void),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError",
      () => Effect.void,
    ),
  );

const withFeatures = <A, E, R>(
  features: ReadonlyArray<StripeEntitlementsFeature>,
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.ensuring(
      Effect.forEach(
        features,
        (feature) => archiveFeature(feature.id).pipe(Effect.ignore),
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    ),
  );

test.provider(
  "create, update, and delete a product feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const feature = yield* ensureFeature(
        "alchemy-pf-lifecycle-feat",
        "Alchemy Product Feature Lifecycle",
      );

      yield* withFeatures(
        [feature],
        Effect.gen(function* () {
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const product = yield* Stripe.Product("PFProduct", {
                name: "Alchemy Product Feature Product",
              });
              const attachment = yield* Stripe.ProductFeature("Analytics", {
                product: product.id,
                entitlementFeature: feature.id,
              });
              return { product, attachment };
            }),
          );

          expect(created.attachment.id).toMatch(/^prodft_/);
          expect(created.attachment.product).toEqual(created.product.id);
          expect(created.attachment.entitlementFeature).toEqual(feature.id);
          expect(created.attachment.livemode).toEqual(false);

          const fetched = yield* GetProductFeature({
            product: created.attachment.product,
            id: created.attachment.id,
          });
          expect(fetched.id).toEqual(created.attachment.id);
          expect(fetched.entitlement_feature.id).toEqual(feature.id);
          expect(fetched.livemode).toEqual(false);

          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const product = yield* Stripe.Product("PFProduct", {
                name: "Alchemy Product Feature Product",
              });
              const attachment = yield* Stripe.ProductFeature("Analytics", {
                product: product.id,
                entitlementFeature: feature.id,
              });
              return { product, attachment };
            }),
          );

          expect(updated.attachment.id).toEqual(created.attachment.id);
          expect(updated.attachment.product).toEqual(created.product.id);
          expect(updated.attachment.entitlementFeature).toEqual(feature.id);

          yield* stack.destroy();

          const gone = yield* waitUntilGone(
            created.attachment.product,
            created.attachment.id,
          );
          expect(gone).toEqual("gone");
        }),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed product feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const feature = yield* ensureFeature(
        "alchemy-pf-list-feat",
        "Alchemy Product Feature List",
      );

      yield* withFeatures(
        [feature],
        Effect.gen(function* () {
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const product = yield* Stripe.Product("PFListProduct", {
                name: "Alchemy Product Feature List Product",
              });
              const attachment = yield* Stripe.ProductFeature("ListAttach", {
                product: product.id,
                entitlementFeature: feature.id,
              });
              return { product, attachment };
            }),
          );

          const provider = yield* Provider.findProvider(Stripe.ProductFeature);
          const all = yield* provider.list();
          const found = all.find(
            (attachment) => attachment.id === deployed.attachment.id,
          );
          expect(found).toBeDefined();
          expect(found?.product).toEqual(deployed.product.id);
          expect(found?.entitlementFeature).toEqual(feature.id);

          yield* stack.destroy();

          const gone = yield* waitUntilGone(
            deployed.attachment.product,
            deployed.attachment.id,
          );
          expect(gone).toEqual("gone");

          const after = yield* provider.list();
          expect(
            after.find(
              (attachment) => attachment.id === deployed.attachment.id,
            ),
          ).toBeUndefined();
        }),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when entitlement feature changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const featureA = yield* ensureFeature(
        "alchemy-pf-replace-feat-a",
        "Alchemy Product Feature Replace A",
      );
      const featureB = yield* ensureFeature(
        "alchemy-pf-replace-feat-b",
        "Alchemy Product Feature Replace B",
      );

      yield* withFeatures(
        [featureA, featureB],
        Effect.gen(function* () {
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              const product = yield* Stripe.Product("PFReplaceProduct", {
                name: "Alchemy Product Feature Replace Product",
              });
              const attachment = yield* Stripe.ProductFeature("ReplaceAttach", {
                product: product.id,
                entitlementFeature: featureA.id,
              });
              return { product, attachment };
            }),
          );

          expect(created.attachment.entitlementFeature).toEqual(featureA.id);

          const replaced = yield* stack.deploy(
            Effect.gen(function* () {
              const product = yield* Stripe.Product("PFReplaceProduct", {
                name: "Alchemy Product Feature Replace Product",
              });
              const attachment = yield* Stripe.ProductFeature("ReplaceAttach", {
                product: product.id,
                entitlementFeature: featureB.id,
              });
              return { product, attachment };
            }),
          );

          expect(replaced.attachment.id).not.toEqual(created.attachment.id);
          expect(replaced.attachment.product).toEqual(created.product.id);
          expect(replaced.attachment.entitlementFeature).toEqual(featureB.id);

          const newFetched = yield* GetProductFeature({
            product: replaced.attachment.product,
            id: replaced.attachment.id,
          });
          expect(newFetched.entitlement_feature.id).toEqual(featureB.id);

          const oldGone = yield* waitUntilGone(
            created.attachment.product,
            created.attachment.id,
          );
          expect(oldGone).toEqual("gone");

          yield* stack.destroy();

          const gone = yield* waitUntilGone(
            replaced.attachment.product,
            replaced.attachment.id,
          );
          expect(gone).toEqual("gone");
        }),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);
