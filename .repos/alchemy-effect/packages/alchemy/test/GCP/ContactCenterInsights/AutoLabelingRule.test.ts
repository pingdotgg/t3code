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
  cci.getProjectsLocationsAutoLabelingRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAutoLabelingRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAutoLabelingRules({
          name: `projects/${project}/locations/us-central1/autoLabelingRules/alchemy-missing-rule`,
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
  "create, update, and delete an auto labeling rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AutoLabelingRule("Topic", {
            displayName: "billing-topic",
            description: "billing",
            active: false,
            conditions: [{ value: '"billing"', condition: "true" }],
          });
        }),
      );

      expect(created.autoLabelingRuleId).toEqual(expect.any(String));
      expect(created.name).toContain("/autoLabelingRules/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("billing-topic");
      expect(created.description).toEqual("billing");
      expect(created.active).toEqual(false);
      expect(created.labelKeyType).toEqual("LABEL_KEY_TYPE_CUSTOM");

      const fetched = yield* cci.getProjectsLocationsAutoLabelingRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("billing");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AutoLabelingRule("Topic", {
            autoLabelingRuleId: created.autoLabelingRuleId,
            location: "us-central1",
            displayName: "billing-topic-v2",
            description: "billing-v2",
            active: false,
            conditions: [{ value: '"support"', condition: "true" }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("billing-topic-v2");
      expect(updated.description).toEqual("billing-v2");
      expect(updated.conditions[0]?.value).toEqual('"support"');

      const fetchedUpdate = yield* cci.getProjectsLocationsAutoLabelingRules({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("billing-topic-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
