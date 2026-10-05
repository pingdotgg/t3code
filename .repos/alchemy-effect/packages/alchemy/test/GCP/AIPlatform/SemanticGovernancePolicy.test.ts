import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Policies govern an existing Vertex AI Agent
// (`projects/{p}/locations/{l}/agents/{a}`), which the v1 API cannot create.
// Set GCP_TEST_AGENT to that agent's resource name to run the lifecycle.
const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_AGENT;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsSemanticGovernancePolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSemanticGovernancePolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsSemanticGovernancePolicies({
          name: `projects/${project}/locations/us-central1/semanticGovernancePolicies/alchemy-sgp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a semantic governance policy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const agent =
        process.env.GCP_TEST_AGENT ??
        `projects/${project}/locations/us-central1/reasoningEngines/missing-agent`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.SemanticGovernancePolicy("Safety", {
            location: "us-central1",
            displayName: "safety",
            description: "no pii",
            agent,
            naturalLanguageConstraint: "Never share customer PII.",
          });
        }),
      );

      expect(created.name).toContain("/semanticGovernancePolicies/");
      expect(created.naturalLanguageConstraint).toEqual(
        "Never share customer PII.",
      );

      const fetched =
        yield* aiplatform.getProjectsLocationsSemanticGovernancePolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.SemanticGovernancePolicy("Safety", {
            location: "us-central1",
            semanticGovernancePolicyId: created.semanticGovernancePolicyId,
            displayName: "safety-v2",
            description: "no pii v2",
            agent,
            naturalLanguageConstraint: "Never share secrets or PII.",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.naturalLanguageConstraint).toEqual(
        "Never share secrets or PII.",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
