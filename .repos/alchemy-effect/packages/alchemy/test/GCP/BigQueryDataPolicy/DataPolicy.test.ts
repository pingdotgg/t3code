import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bqdp from "@distilled.cloud/gcp/bigquerydatapolicy_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const location = "us-central1";

const waitUntilGone = (name: string) =>
  bqdp.getProjectsLocationsDataPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bqdp.getProjectsLocationsDataPolicies({
          name: `projects/${project}/locations/${location}/dataPolicies/alchemy-missing-data-policy`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigquerydatapolicy", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a data policy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryDataPolicy.DataPolicy("Mask", {
            location,
            dataPolicyType: "DATA_MASKING_POLICY",
            dataMaskingPolicy: { predefinedExpression: "SHA256" },
          });
        }),
      );

      expect(created.name).toContain("/dataPolicies/");
      expect(created.dataPolicyId).toEqual(expect.any(String));
      expect(created.dataPolicyId.startsWith("alch_")).toEqual(true);
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.dataPolicyType).toEqual("DATA_MASKING_POLICY");
      expect(created.dataMaskingPolicy?.predefinedExpression).toEqual("SHA256");

      const fetched = yield* bqdp.getProjectsLocationsDataPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.dataPolicyId).toEqual(created.dataPolicyId);
      expect(fetched.dataPolicyType).toEqual("DATA_MASKING_POLICY");
      expect(fetched.dataMaskingPolicy?.predefinedExpression).toEqual("SHA256");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryDataPolicy.DataPolicy("Mask", {
            dataPolicyId: created.dataPolicyId,
            location,
            dataPolicyType: "DATA_MASKING_POLICY",
            dataMaskingPolicy: { predefinedExpression: "ALWAYS_NULL" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.dataPolicyId).toEqual(created.dataPolicyId);
      expect(updated.dataMaskingPolicy?.predefinedExpression).toEqual(
        "ALWAYS_NULL",
      );

      const refetched = yield* bqdp.getProjectsLocationsDataPolicies({
        name: created.name,
      });
      expect(refetched.dataMaskingPolicy?.predefinedExpression).toEqual(
        "ALWAYS_NULL",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigquerydatapolicy", "live"],
    timeout: 90_000,
  },
);
