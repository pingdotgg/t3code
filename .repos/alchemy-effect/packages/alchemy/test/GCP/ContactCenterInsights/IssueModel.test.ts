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
  cci.getProjectsLocationsIssueModels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsIssueModels on a missing model fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsIssueModels({
          name: `projects/${project}/locations/us-central1/issueModels/alchemy-missing-model`,
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

// Needs a project with at least 100 analyzed conversations; otherwise create fails with
// BadRequest "Project: `...` has too few conversations with the given filters.
// Current number: 0. Minimum requirement is: 100."
test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_CCI_ISSUE_MODELS,
)(
  "create, update, and delete an issue model",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.IssueModel("Topics", {
            location: "us-central1",
            displayName: "billing-topics",
            languageCode: "en-US",
            modelType: "TYPE_V2",
          });
        }),
      );

      expect(created.name).toContain("/issueModels/");
      expect(created.displayName).toEqual("billing-topics");

      const fetched = yield* cci.getProjectsLocationsIssueModels({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.IssueModel("Topics", {
            location: "us-central1",
            displayName: "billing-topics-v2",
            languageCode: "en-US",
            modelType: "TYPE_V2",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("billing-topics-v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 120_000,
  },
);
