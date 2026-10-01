import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetIssuingPersonalizationDesigns,
  GetIssuingPersonalizationDesign,
  GetIssuingPhysicalBundles,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const ISSUING_ENABLED = process.env.STRIPE_TEST_ISSUING === "1";

const pickPhysicalBundle = Effect.gen(function* () {
  const standard = yield* GetIssuingPhysicalBundles({
    type: "standard",
    status: "active",
    limit: 1,
  });
  if (standard.data[0] !== undefined) return standard.data[0];
  const active = yield* GetIssuingPhysicalBundles({
    status: "active",
    limit: 1,
  });
  if (active.data[0] !== undefined) return active.data[0];
  const any = yield* GetIssuingPhysicalBundles({ limit: 1 });
  return any.data[0];
});

test.provider(
  "issuing personalization designs entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* GetIssuingPersonalizationDesigns({ limit: 1 }).pipe(
        Effect.result,
      );

      if (Result.isFailure(result)) {
        // Unentitled — distilled must fail with a typed tag, never
        // UnknownStripeError. Exact error:
        // InvalidRequestError: "Your account is not set up to use Issuing.
        // Please visit https://dashboard.stripe.com/issuing/overview to get
        // started."
        expect(result.failure._tag).not.toEqual("UnknownStripeError");
        expect(["InvalidRequestError", "Forbidden"]).toContain(
          result.failure._tag,
        );
        if (result.failure._tag === "InvalidRequestError") {
          expect(result.failure.message).toContain("not set up to use Issuing");
        }
        yield* stack.destroy();
        return;
      }

      expect(Array.isArray(result.success.data)).toBe(true);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!ISSUING_ENABLED)(
  "create, update, and destroy a personalization design",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bundle = yield* pickPhysicalBundle;
      expect(bundle).toBeDefined();
      const physicalBundle = bundle!.id;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.IssuingPersonalizationDesign("CardDesign", {
            physicalBundle,
            name: "Alchemy Card Design",
            metadata: { line: "test" },
          });
        }),
      );

      expect(created.id).toMatch(/^ipcd_/);
      expect(created.name).toEqual("Alchemy Card Design");
      expect(created.physicalBundle).toEqual(physicalBundle);
      expect(created.lookupKey).toEqual(expect.any(String));
      expect(created.isDefault).toEqual(false);
      expect(created.metadata).toMatchObject({ line: "test" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);
      expect(["active", "inactive", "rejected", "review"]).toContain(
        created.status,
      );

      const fetched = yield* GetIssuingPersonalizationDesign({
        personalization_design: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual("Alchemy Card Design");
      expect(
        typeof fetched.physical_bundle === "string"
          ? fetched.physical_bundle
          : fetched.physical_bundle.id,
      ).toEqual(physicalBundle);
      expect(fetched.metadata?.line).toEqual("test");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.IssuingPersonalizationDesign("CardDesign", {
            physicalBundle,
            name: "Alchemy Card Design Updated",
            metadata: { line: "test", version: "2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("Alchemy Card Design Updated");
      expect(updated.physicalBundle).toEqual(physicalBundle);
      expect(updated.metadata).toEqual({ line: "test", version: "2" });

      const refetched = yield* GetIssuingPersonalizationDesign({
        personalization_design: updated.id,
      });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.name).toEqual("Alchemy Card Design Updated");
      expect(refetched.metadata?.line).toEqual("test");
      expect(refetched.metadata?.version).toEqual("2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      // No delete/archive API — destroy is a no-op and the design remains.
      const residue = yield* GetIssuingPersonalizationDesign({
        personalization_design: created.id,
      }).pipe(
        Effect.catchIf(isMissingStripeResource, () =>
          Effect.succeed(undefined),
        ),
      );
      expect(residue).toBeDefined();
      expect(residue?.id).toEqual(created.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ISSUING_ENABLED)(
  "list enumerates the deployed personalization design",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bundle = yield* pickPhysicalBundle;
      expect(bundle).toBeDefined();
      const physicalBundle = bundle!.id;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.IssuingPersonalizationDesign("ListDesign", {
            physicalBundle,
            name: "Alchemy List Card Design",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Stripe.IssuingPersonalizationDesign,
      );
      const all = yield* provider.list();
      const found = all.find((design) => design.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.physicalBundle).toEqual(physicalBundle);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      // Residue stays listed — destroy cannot untag or delete the object.
      const after = yield* provider.list();
      expect(after.find((design) => design.id === deployed.id)).toBeDefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
