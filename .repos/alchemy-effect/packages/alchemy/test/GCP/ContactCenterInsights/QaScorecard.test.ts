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
  cci.getProjectsLocationsQaScorecards({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsQaScorecards on a missing scorecard fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsQaScorecards({
          name: `projects/${project}/locations/us-central1/qaScorecards/alchemy-missing-card`,
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
// have enabled: create succeeds but every PATCH returns 404 NOT_FOUND "Requested entity was not found."
test.provider.skipIf(!process.env.GCP_TEST_CCAI_QUALITY || !!process.env.FAST)(
  "create, update, and delete a qa scorecard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.QaScorecard("Quality", {
            location: "us-central1",
            displayName: "quality",
            description: "call quality",
          });
        }),
      );

      expect(created.name).toContain("/qaScorecards/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("quality");
      expect(created.description).toEqual("call quality");

      const fetched = yield* cci.getProjectsLocationsQaScorecards({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.displayName).toEqual("quality");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.QaScorecard("Quality", {
            qaScorecardId: created.qaScorecardId,
            location: "us-central1",
            displayName: "quality-v2",
            description: "updated quality",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("quality-v2");
      expect(updated.description).toEqual("updated quality");

      const fetchedUpdate = yield* cci.getProjectsLocationsQaScorecards({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("quality-v2");
      expect(fetchedUpdate.description).toContain("updated quality");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
