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
  apigee.getOrganizationsEnvironmentsTraceConfigOverrides({ name }).pipe(
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
  "getOrganizationsEnvironmentsTraceConfigOverrides on a missing override fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsTraceConfigOverrides({
          name: `${org}/environments/alchemy-missing/traceConfig/overrides/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a trace config override",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const api = yield* GCP.Apigee.Api("Orders", {});
          const override = yield* GCP.Apigee.EnvironmentsTraceConfigOverride(
            "ProxyTrace",
            {
              environment: environment.environmentId,
              apiProxy: api.apiId,
              samplingConfig: { sampler: "PROBABILITY", samplingRate: 0.1 },
            },
          );
          return { environment, api, override };
        }),
      );

      expect(created.override.traceConfigOverrideId).toEqual(
        expect.any(String),
      );
      expect(created.override.apiProxy).toEqual(created.api.apiId);
      expect(created.override.samplingConfig?.sampler).toEqual("PROBABILITY");

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsTraceConfigOverrides({
          name: created.override.name,
        });
      expect(fetched.apiProxy).toEqual(created.api.apiId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const api = yield* GCP.Apigee.Api("Orders", {
            apiId: created.api.apiId,
          });
          const override = yield* GCP.Apigee.EnvironmentsTraceConfigOverride(
            "ProxyTrace",
            {
              environment: environment.environmentId,
              apiProxy: api.apiId,
              samplingConfig: { sampler: "PROBABILITY", samplingRate: 0.2 },
            },
          );
          return { environment, api, override };
        }),
      );

      expect(updated.override.name).toEqual(created.override.name);
      expect(updated.override.samplingConfig?.samplingRate).toEqual(0.2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.override.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
