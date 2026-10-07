import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

// The gates are decided at deploy time and passed to the deployed host
// through its env, so the host serves exactly the probes it was bound for.
const gate = (name: string, atDeploy: boolean) => {
  const passed = process.env[name];
  // Host env values arrive JSON-encoded (`"1"`).
  return passed === undefined ? atDeploy : passed.replace(/"/g, "") === "1";
};

/**
 * Sandbox environments and templates take 1-3 minutes to provision.
 */
export const runSandboxes = gate("AIPLATFORM_SANDBOXES", !process.env.FAST);

/**
 * pauseReasoningEnginesSandboxEnvironments does not work on the testing
 * project (the sandbox itself creates fine): it has answered
 * InternalServerError "Internal error encountered.", and from the host the
 * first calls drop the connection (Cloud Run 503) after which the sandbox
 * answers FAILED_PRECONDITION "is not in RUNNING, PAUSING or STOPPING
 * state, cannot be paused.". Set GCP_TEST_AIPLATFORM_SANDBOX_PAUSE=1 where
 * pausing works.
 */
export const runSandboxPause = gate(
  "AIPLATFORM_SANDBOX_PAUSE",
  runSandboxes && !!process.env.GCP_TEST_AIPLATFORM_SANDBOX_PAUSE,
);

/** Reasoning engine without a deployed package (queries are refused). */
export const Agent = GCP.AIPlatform.ReasoningEngine("Agent", {
  location: "us-central1",
  displayName: "alchemy-binding-engine",
  spec: { agentFramework: "custom" },
});

/** Custom training pipeline the host reads and cancels. */
export const Train = GCP.AIPlatform.TrainingPipeline("Train", {
  location: "us-central1",
  displayName: "alchemy-binding-pipeline",
  trainingTaskDefinition:
    "gs://google-cloud-aiplatform/schema/trainingjob/definition/custom_task_1.0.0.yaml",
  trainingTaskInputs: {
    workerPoolSpecs: [
      {
        machineSpec: { machineType: "n1-standard-4" },
        replicaCount: "1",
        containerSpec: {
          imageUri:
            "us-docker.pkg.dev/vertex-ai/training/tf-cpu.2-12.py310:latest",
          // Runs long enough for the host to cancel it.
          command: ["sleep", "1800"],
        },
      },
    ],
  },
});

const sandbox = (id: string, displayName: string) =>
  Effect.gen(function* () {
    const engine = yield* Agent;
    return yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironment(id, {
      reasoningEngine: engine.name,
      displayName,
      ttl: "600s",
      spec: {
        codeExecutionEnvironment: {
          codeLanguage: "LANGUAGE_PYTHON",
          machineConfig: "MACHINE_CONFIG_VCPU4_RAM4GIB",
        },
      },
    });
  });

/** Sandbox the host reads. */
export const Code = sandbox("Code", "code");
/** Sandbox the host pauses. */
export const Paused = sandbox("Paused", "paused");
/** Sandbox the host pauses and resumes. */
export const Resumed = sandbox("Resumed", "resumed");

/** Sandbox template the host reads. */
export const Browser = Effect.gen(function* () {
  const engine = yield* Agent;
  return yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate(
    "Browser",
    {
      reasoningEngine: engine.name,
      displayName: "browser",
      defaultContainerEnvironment: {
        defaultContainerCategory: "DEFAULT_CONTAINER_CATEGORY_COMPUTER_USE",
      },
    },
  );
});

/** Sandbox probes, declared only when their resources are deployed. */
const sandboxProbes = Effect.gen(function* () {
  if (!runSandboxes) return {};
  const getSandbox = yield* GCP.AIPlatform.GetSandboxEnvironment(Code);
  const getTemplate =
    yield* GCP.AIPlatform.GetSandboxEnvironmentTemplate(Browser);
  const probes = {
    getSandboxEnvironment: getSandbox(),
    getSandboxEnvironmentTemplate: getTemplate(),
  };
  if (!runSandboxPause) return probes;
  const pause = yield* GCP.AIPlatform.PauseSandboxEnvironment(Paused);
  const pauseResumed = yield* GCP.AIPlatform.PauseSandboxEnvironment(Resumed);
  const resume = yield* GCP.AIPlatform.ResumeSandboxEnvironment(Resumed);
  return {
    ...probes,
    pauseSandboxEnvironment: pause({ body: {} }),
    resumeSandboxEnvironment: Effect.gen(function* () {
      yield* pauseResumed({ body: {} });
      return yield* resume({ body: {} });
    }),
  };
});

/**
 * Effect-native Cloud Run service exercising every AI Platform binding as
 * its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class AIPlatformBindingsHost extends GCP.Function<AIPlatformBindingsHost>()(
  "AIPlatformBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: {
      AIPLATFORM_SANDBOXES: runSandboxes ? "1" : "0",
      AIPLATFORM_SANDBOX_PAUSE: runSandboxPause ? "1" : "0",
    },
  },
  Effect.gen(function* () {
    const gemini = yield* GCP.AIPlatform.GenerateContent("gemini-2.5-flash");
    const regional = yield* GCP.AIPlatform.GenerateContent({
      model: "gemini-2.5-flash",
      location: "us-central1",
    });
    const getEngine = yield* GCP.AIPlatform.GetReasoningEngine(Agent);
    const queryEngine = yield* GCP.AIPlatform.QueryReasoningEngine(Agent);
    const getPipeline = yield* GCP.AIPlatform.GetTrainingPipeline(Train);
    const cancelPipeline = yield* GCP.AIPlatform.CancelTrainingPipeline(Train);
    const sandboxes = yield* sandboxProbes;

    return {
      fetch: serveProbes({
        generateContent: Effect.gen(function* () {
          const text = yield* gemini.text("Reply with exactly: pong");
          const response = yield* regional.generate({
            contents: [
              { role: "user", parts: [{ text: "Reply with exactly: ping" }] },
            ],
          });
          return {
            text,
            regional:
              response.candidates?.[0]?.content?.parts
                ?.map((part) => part.text ?? "")
                .join("") ?? "",
            modelVersion: response.modelVersion,
          };
        }),
        getReasoningEngine: getEngine(),
        queryReasoningEngine: queryEngine({
          body: { input: { input: "hello" } },
        }),
        getTrainingPipeline: getPipeline(),
        cancelTrainingPipeline: cancelPipeline({ body: {} }),
        ...sandboxes,
      }),
    };
  }).pipe(
    Effect.provide(GCP.AIPlatform.GenerateContentHttp),
    Effect.provide(GCP.AIPlatform.GetReasoningEngineHttp),
    Effect.provide(GCP.AIPlatform.QueryReasoningEngineHttp),
    Effect.provide(GCP.AIPlatform.GetTrainingPipelineHttp),
    Effect.provide(GCP.AIPlatform.CancelTrainingPipelineHttp),
    Effect.provide(GCP.AIPlatform.GetSandboxEnvironmentHttp),
    Effect.provide(GCP.AIPlatform.GetSandboxEnvironmentTemplateHttp),
    Effect.provide(GCP.AIPlatform.PauseSandboxEnvironmentHttp),
    Effect.provide(GCP.AIPlatform.ResumeSandboxEnvironmentHttp),
  ),
) {}
