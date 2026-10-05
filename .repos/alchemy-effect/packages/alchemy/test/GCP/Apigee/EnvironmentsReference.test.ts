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
  apigee.getOrganizationsEnvironmentsReferences({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsEnvironmentsReferences on a missing reference fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsReferences({
          name: `${org}/environments/alchemy-missing/references/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an environment reference",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
            environment: environment.environmentId,
          });
          const reference = yield* GCP.Apigee.EnvironmentsReference("TlsRef", {
            environment: environment.environmentId,
            refers: keystore.keystoreId,
            resourceType: "KeyStore",
            description: "tls keystore",
          });
          return { environment, keystore, reference };
        }),
      );

      expect(created.reference.referenceId).toEqual(expect.any(String));
      expect(created.reference.refers).toEqual(created.keystore.keystoreId);
      expect(created.reference.description).toEqual("tls keystore");

      const fetched = yield* apigee.getOrganizationsEnvironmentsReferences({
        name: created.reference.name,
      });
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("tls keystore");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
            environment: environment.environmentId,
            keystoreId: created.keystore.keystoreId,
          });
          const reference = yield* GCP.Apigee.EnvironmentsReference("TlsRef", {
            environment: environment.environmentId,
            referenceId: created.reference.referenceId,
            refers: keystore.keystoreId,
            resourceType: "KeyStore",
            description: "updated tls keystore",
          });
          return { environment, keystore, reference };
        }),
      );

      expect(updated.reference.name).toEqual(created.reference.name);
      expect(updated.reference.description).toEqual("updated tls keystore");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.reference.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
