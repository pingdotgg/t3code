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
  apigee.getOrganizationsEnvironmentsKeystoresAliases({ name }).pipe(
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
  "getOrganizationsEnvironmentsKeystoresAliases on a missing alias fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsKeystoresAliases({
          name: `${org}/environments/alchemy-missing/keystores/alchemy-missing/aliases/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a keystore alias",
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
          const alias = yield* GCP.Apigee.EnvironmentsKeystoresAlias("Server", {
            environment: environment.environmentId,
            keystore: keystore.keystoreId,
            subject: { commonName: "api.example.com" },
            certValidityInDays: 365,
          });
          return { environment, keystore, alias };
        }),
      );

      expect(created.alias.aliasId).toEqual(expect.any(String));
      expect(created.alias.keystoreId).toEqual(created.keystore.keystoreId);
      expect(created.alias.environmentId).toEqual(
        created.environment.environmentId,
      );

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsKeystoresAliases({
          name: created.alias.name,
        });
      expect(fetched.alias).toEqual(created.alias.aliasId);

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
          const alias = yield* GCP.Apigee.EnvironmentsKeystoresAlias("Server", {
            environment: environment.environmentId,
            keystore: keystore.keystoreId,
            aliasId: created.alias.aliasId,
            subject: { commonName: "api.example.com" },
            certValidityInDays: 30,
          });
          return { environment, keystore, alias };
        }),
      );

      expect(updated.alias.name).toEqual(created.alias.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.alias.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
