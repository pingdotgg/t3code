import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

// Product-scoped (`products/IP`) auth configs are rejected on a standard
// project with Forbidden ("User is not authorized to create AuthConfig with
// name … as they don't have membership of project {number}"), and product
// Salesforce instances need one. Set GCP_TEST_INTEGRATIONS_PRODUCT_AUTH=1 on a
// project entitled to the legacy product surface.
const runProductAuthLifecycle =
  !!process.env.GCP_TEST_INTEGRATIONS_PRODUCT_AUTH;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsProductsAuthConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const credential = {
  credentialType: "USERNAME_AND_PASSWORD" as const,
  usernameAndPassword: { username: "alchemy", password: "test-secret" },
};

test.provider(
  "getProjectsLocationsProductsAuthConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsAuthConfigs({
          name: `projects/${project}/locations/us-central1/products/IP/authConfigs/alchemy-missing-auth`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runProductAuthLifecycle)(
  "createProjectsLocationsProductsAuthConfigs without product membership is Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.createProjectsLocationsProductsAuthConfigs({
          parent: `projects/${project}/locations/us-central1/products/IP`,
          body: {
            displayName: "alchemy-product-probe",
            decryptedCredential: credential,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("membership of project");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runProductAuthLifecycle)(
  "create, update, and delete a product auth config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsAuthConfig("Salesforce", {
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-product-salesforce",
            description: "basic auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(created.name).toContain("/authConfigs/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-product-salesforce");
      expect(created.description).toEqual("basic auth");

      const fetched =
        yield* integrations.getProjectsLocationsProductsAuthConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("basic auth");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsAuthConfig("Salesforce", {
            authConfigId: created.authConfigId,
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-product-salesforce",
            description: "updated auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated auth");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
