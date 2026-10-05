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

// Sandbox template provisioning takes 1-2 minutes.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform
    .getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform
          .getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({
            name: `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789/sandboxEnvironmentTemplates/1234567890123456789`,
          })
          .pipe(Effect.timeout("15 seconds")),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 30_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a sandbox environment template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-template-engine",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const template =
            yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate(
              "Browser",
              {
                reasoningEngine: engine.name,
                displayName: "browser",
                defaultContainerEnvironment: {
                  defaultContainerCategory:
                    "DEFAULT_CONTAINER_CATEGORY_COMPUTER_USE",
                },
              },
            );
          return { engine, template };
        }),
      );

      expect(created.template.name).toContain("/sandboxEnvironmentTemplates/");
      expect(created.template.displayName).toEqual("browser");
      expect(created.template.reasoningEngine).toEqual(created.engine.name);

      const fetched =
        yield* aiplatform.getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates(
          {
            name: created.template.name,
          },
        );
      expect(fetched.name).toEqual(created.template.name);
      expect(fetched.displayName).toContain("[alchemy ");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.template.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
