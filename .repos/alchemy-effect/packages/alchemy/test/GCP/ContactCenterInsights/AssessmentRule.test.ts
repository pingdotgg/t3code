import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
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
  cci.getProjectsLocationsAssessmentRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAssessmentRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAssessmentRules({
          name: `projects/${project}/locations/us-central1/assessmentRules/alchemymissingrule`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

// Needs Contact Center AI Insights features the testing project does not
// have enabled: create returns 404 NOT_FOUND "Requested entity was not found." and list returns 400 INVALID_ARGUMENT.
test.provider.skipIf(!process.env.GCP_TEST_CCAI_QUALITY || !!process.env.FAST)(
  "create, update, and delete an assessment rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AssessmentRule("Qa", {
            displayName: "qa",
            active: false,
            sampleRule: { samplePercentage: 0.1 },
            scheduleInfo: { schedule: "every 1 hours", timeZone: "UTC" },
          });
        }),
      );

      expect(created.assessmentRuleId).toEqual(expect.any(String));
      expect(created.name).toContain("/assessmentRules/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("qa");
      expect(created.active).toEqual(false);
      expect(created.sampleRule?.samplePercentage).toEqual(0.1);

      const fetched = yield* cci.getProjectsLocationsAssessmentRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.active ?? false).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AssessmentRule("Qa", {
            assessmentRuleId: created.assessmentRuleId,
            location: "us-central1",
            displayName: "qa-2",
            active: false,
            sampleRule: { samplePercentage: 0.2 },
            scheduleInfo: { schedule: "every 2 hours", timeZone: "UTC" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("qa-2");
      expect(updated.sampleRule?.samplePercentage).toEqual(0.2);
      expect(updated.scheduleInfo?.schedule).toEqual("every 2 hours");

      const fetchedUpdate = yield* cci.getProjectsLocationsAssessmentRules({
        name: updated.name,
      });
      expect(fetchedUpdate.sampleRule?.samplePercentage).toEqual(0.2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
