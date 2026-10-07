import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
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

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsIntegrationsVersionsTestCases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const apiTrigger = [
  {
    label: "API Trigger",
    triggerType: "API" as const,
    triggerNumber: "1",
    triggerId: "api_trigger/alchemy_testcase",
    properties: { "Trigger name": "alchemy_testcase" },
  },
];

test.provider(
  "getProjectsLocationsIntegrationsVersionsTestCases on a missing case fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsIntegrationsVersionsTestCases({
          name: `projects/${project}/locations/us-central1/integrations/alchemy-missing/versions/00000000-0000-0000-0000-000000000000/testCases/missing`,
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

test.provider(
  "create, update, and delete an integration version test case",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const version = yield* GCP.Integrations.IntegrationsVersion(
            "Orders",
            {
              location: "us-central1",
              description: "testcase parent",
              triggerConfigs: apiTrigger,
            },
          );
          const testCase =
            yield* GCP.Integrations.IntegrationsVersionsTestCases("HappyPath", {
              version: version.name,
              location: "us-central1",
              displayName: "happy-path",
              description: "fires the API trigger",
              triggerId: "api_trigger/alchemy_testcase",
            });
          return { version, testCase };
        }),
      );

      expect(created.testCase.name).toContain("/testCases/");
      expect(created.testCase.displayName).toEqual("happy-path");
      expect(created.testCase.description).toEqual("fires the API trigger");
      expect(created.testCase.triggerId).toEqual(
        "api_trigger/alchemy_testcase",
      );

      const fetched =
        yield* integrations.getProjectsLocationsIntegrationsVersionsTestCases({
          name: created.testCase.name,
        });
      expect(fetched.name).toEqual(created.testCase.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const version = yield* GCP.Integrations.IntegrationsVersion(
            "Orders",
            {
              integrationId: created.version.integrationId,
              versionId: created.version.versionId,
              location: "us-central1",
              description: "testcase parent",
              triggerConfigs: apiTrigger,
            },
          );
          const testCase =
            yield* GCP.Integrations.IntegrationsVersionsTestCases("HappyPath", {
              version: version.name,
              testCaseId: created.testCase.testCaseId,
              location: "us-central1",
              displayName: "happy-path",
              description: "updated case",
              triggerId: "api_trigger/alchemy_testcase",
            });
          return { version, testCase };
        }),
      );

      expect(updated.testCase.name).toEqual(created.testCase.name);
      expect(updated.testCase.description).toEqual("updated case");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.testCase.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
