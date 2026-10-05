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
  cci.getProjectsLocationsAnalysisRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAnalysisRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAnalysisRules({
          name: `projects/${project}/locations/us-central1/analysisRules/alchemy-missing-rule`,
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

test.provider(
  "create, update, and delete an analysis rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AnalysisRule("Draft", {
            displayName: "draft",
            active: false,
            analysisPercentage: 0,
            annotatorSelector: { runSentimentAnnotator: true },
          });
        }),
      );

      expect(created.analysisRuleId).toEqual(expect.any(String));
      expect(created.name).toContain("/analysisRules/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("draft");
      expect(created.active).toEqual(false);
      expect(created.annotatorSelector?.runSentimentAnnotator).toEqual(true);

      const fetched = yield* cci.getProjectsLocationsAnalysisRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("draft");
      expect(fetched.active ?? false).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterInsights.AnalysisRule("Draft", {
            analysisRuleId: created.analysisRuleId,
            location: "us-central1",
            displayName: "draft-2",
            conversationFilter: 'agent_id="alchemy-agent"',
            active: false,
            analysisPercentage: 0,
            annotatorSelector: { runSilenceAnnotator: true },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("draft-2");
      expect(updated.conversationFilter).toEqual('agent_id="alchemy-agent"');
      expect(updated.annotatorSelector?.runSilenceAnnotator).toEqual(true);

      const fetchedUpdate = yield* cci.getProjectsLocationsAnalysisRules({
        name: updated.name,
      });
      expect(fetchedUpdate.conversationFilter).toEqual(
        'agent_id="alchemy-agent"',
      );
      expect(fetchedUpdate.annotatorSelector?.runSilenceAnnotator).toEqual(
        true,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
