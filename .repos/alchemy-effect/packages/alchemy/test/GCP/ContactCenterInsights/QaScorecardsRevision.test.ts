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
  cci.getProjectsLocationsQaScorecardsRevisions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsQaScorecardsRevisions on a missing revision fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsQaScorecardsRevisions({
          name: `projects/${project}/locations/us-central1/qaScorecards/missing/revisions/missing`,
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
// have enabled: the parent scorecard's PATCH returns 404 NOT_FOUND "Requested entity was not found."
test.provider.skipIf(!process.env.GCP_TEST_CCAI_QUALITY || !!process.env.FAST)(
  "create, update, and delete a qa scorecard revision",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const card = yield* GCP.ContactCenterInsights.QaScorecard("Quality", {
            location: "us-central1",
            displayName: "quality",
            description: "call quality",
          });
          return yield* GCP.ContactCenterInsights.QaScorecardsRevision("V1", {
            parent: card.name,
          });
        }),
      );

      expect(created.name).toContain("/revisions/");
      expect(created.parent).toContain("/qaScorecards/");
      expect(created.qaScorecardRevisionId).toEqual(expect.any(String));

      const fetched = yield* cci.getProjectsLocationsQaScorecardsRevisions({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const card = yield* GCP.ContactCenterInsights.QaScorecard("Quality", {
            location: "us-central1",
            displayName: "quality-v2",
            description: "updated quality",
          });
          return yield* GCP.ContactCenterInsights.QaScorecardsRevision("V1", {
            parent: card.name,
            qaScorecardRevisionId: created.qaScorecardRevisionId,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.parent).toEqual(created.parent);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
