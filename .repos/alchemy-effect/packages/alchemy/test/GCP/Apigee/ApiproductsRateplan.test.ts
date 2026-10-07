import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsApiproductsRateplans({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsApiproductsRateplans on a missing rate plan fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsApiproductsRateplans({
          name: `${org}/apiproducts/missing-product/rateplans/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an api product rate plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Apigee.Apiproduct("Public", {
            displayName: "Public APIs",
            approvalType: "auto",
          });
          const plan = yield* GCP.Apigee.ApiproductsRateplan("Standard", {
            apiproduct: product.apiproductId,
            displayName: "Standard",
            description: "monthly plan",
            billingPeriod: "MONTHLY",
            currencyCode: "USD",
            state: "DRAFT",
          });
          return { product, plan };
        }),
      );

      expect(created.plan.rateplanId).toEqual(expect.any(String));
      expect(created.plan.apiproductId).toEqual(created.product.apiproductId);
      expect(created.plan.displayName).toEqual("Standard");
      expect(created.plan.description).toEqual("monthly plan");

      const fetched = yield* apigee.getOrganizationsApiproductsRateplans({
        name: created.plan.name,
      });
      expect(fetched.description).toEqual("monthly plan");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Apigee.Apiproduct("Public", {
            apiproductId: created.product.apiproductId,
            displayName: "Public APIs",
            approvalType: "auto",
          });
          const plan = yield* GCP.Apigee.ApiproductsRateplan("Standard", {
            apiproduct: product.apiproductId,
            displayName: "Standard Plus",
            description: "updated monthly plan",
            billingPeriod: "MONTHLY",
            currencyCode: "USD",
            state: "DRAFT",
          });
          return { product, plan };
        }),
      );

      expect(updated.plan.name).toEqual(created.plan.name);
      expect(updated.plan.displayName).toEqual("Standard Plus");
      expect(updated.plan.description).toEqual("updated monthly plan");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.plan.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
