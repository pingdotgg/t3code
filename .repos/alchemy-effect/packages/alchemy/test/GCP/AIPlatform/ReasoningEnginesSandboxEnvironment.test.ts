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

const waitUntilGone = (name: string) =>
  aiplatform.getReasoningEnginesSandboxEnvironments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getReasoningEnginesSandboxEnvironments on a missing sandbox fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getReasoningEnginesSandboxEnvironments({
          name: `projects/${project}/locations/us-central1/reasoningEngines/1234567890123456789/sandboxEnvironments/1234567890123456789`,
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

test.provider.skipIf(!!process.env.FAST)(
  "create and delete a sandbox environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-sandbox-engine",
            labels: { env: "test" },
            spec: { agentFramework: "custom" },
          });
          const sandbox =
            yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironment("Code", {
              reasoningEngine: engine.name,
              displayName: "code",
              ttl: "600s",
              spec: {
                codeExecutionEnvironment: {
                  codeLanguage: "LANGUAGE_PYTHON",
                  machineConfig: "MACHINE_CONFIG_VCPU4_RAM4GIB",
                },
              },
            });
          return { engine, sandbox };
        }),
      );

      expect(created.sandbox.name).toContain("/sandboxEnvironments/");
      expect(created.sandbox.displayName).toEqual("code");
      expect(created.sandbox.reasoningEngine).toEqual(created.engine.name);

      const fetched = yield* aiplatform.getReasoningEnginesSandboxEnvironments({
        name: created.sandbox.name,
      });
      expect(fetched.name).toEqual(created.sandbox.name);
      expect(fetched.displayName ?? "").toMatch(/\[alc(hemy)? /);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.sandbox.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
