import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { callProbe, dockerAvailable, expectProbe } from "../bindingHost.ts";
import AIPlatformBindingsHost, {
  Agent,
  Browser,
  Code,
  Paused,
  Resumed,
  runSandboxes,
  runSandboxPause,
  Train,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AIPlatformBindings");

let baseUrl: string;
let hostAccount: string;
let names: {
  engine: string;
  pipeline: string;
  sandbox?: string;
  template?: string;
  paused?: string;
  resumed?: string;
};

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }))
      .sort((left, right) => (left.role ?? "").localeCompare(right.role ?? ""));
  });

/**
 * Vertex AI resources have no resource-level IAM policy, so every AI
 * Platform binding grants on the project: aiplatform.viewer for reads,
 * aiplatform.user for predict / cancel / pause / resume.
 */
const PROJECT_GRANTS = [
  { role: "roles/aiplatform.user", condition: undefined },
  { role: "roles/aiplatform.viewer", condition: undefined },
];

const expectProjectGrants = Effect.gen(function* () {
  expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
});

describe.skipIf(!dockerAvailable)(
  "AIPlatform Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:aiplatform",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* AIPlatformBindingsHost;
            const engine = yield* Agent;
            const pipeline = yield* Train;
            const sandboxes = runSandboxes
              ? {
                  sandbox: (yield* Code).name,
                  template: (yield* Browser).name,
                }
              : {};
            const paused = runSandboxPause
              ? {
                  paused: (yield* Paused).name,
                  resumed: (yield* Resumed).name,
                }
              : {};
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              names: {
                engine: engine.name,
                pipeline: pipeline.name,
                ...sandboxes,
                ...paused,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        names = out.names;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GenerateContent", () => {
      test.provider(
        "calls Gemini (global and regional) as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              text: string;
              regional: string;
              modelVersion?: string;
            }>(baseUrl, "generateContent");
            expect(out.text.toLowerCase()).toContain("pong");
            expect(out.regional.toLowerCase()).toContain("ping");
            expect(out.modelVersion).toContain("gemini-2.5-flash");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetReasoningEngine", () => {
      test.provider(
        "reads the reasoning engine as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              displayName?: string;
            }>(baseUrl, "getReasoningEngine");
            const expected = yield* aiplatform.getReasoningEngines({
              name: names.engine,
            });
            expect(live.name).toEqual(names.engine);
            expect(live.displayName).toEqual(expected.displayName);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("QueryReasoningEngine", () => {
      test.provider(
        "queries the reasoning engine as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            // The engine has no deployed package, so the query is refused
            // after authorization — the same answer the deployer gets.
            const outcome = yield* callProbe(baseUrl, "queryReasoningEngine");
            expect(outcome.ok ? "ok" : outcome.error._tag).toEqual(
              "ReasoningEngineNotRunning",
            );
            const expected = yield* aiplatform
              .queryReasoningEngines({
                name: names.engine,
                body: { input: { input: "hello" } },
              })
              .pipe(
                Effect.map(() => "ok"),
                Effect.catchTag("ReasoningEngineNotRunning", (error) =>
                  Effect.succeed(error._tag),
                ),
              );
            expect(expected).toEqual("ReasoningEngineNotRunning");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetTrainingPipeline", () => {
      test.provider(
        "reads the training pipeline as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              displayName?: string;
            }>(baseUrl, "getTrainingPipeline");
            expect(live.name).toEqual(names.pipeline);
            expect(live.displayName).toEqual("alchemy-binding-pipeline");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("CancelTrainingPipeline", () => {
      test.provider(
        "cancels the training pipeline as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "cancelTrainingPipeline");
            const pipeline = yield* aiplatform
              .getProjectsLocationsTrainingPipelines({ name: names.pipeline })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  // Wait for CANCELLED (not just CANCELLING): only a
                  // settled pipeline can be deleted on teardown.
                  until: (live) => live.state === "PIPELINE_STATE_CANCELLED",
                  times: 36,
                }),
              );
            expect(pipeline.state).toEqual("PIPELINE_STATE_CANCELLED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!runSandboxes)("GetSandboxEnvironment", () => {
      test.provider(
        "reads the sandbox environment as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              displayName?: string;
            }>(baseUrl, "getSandboxEnvironment");
            const expected =
              yield* aiplatform.getReasoningEnginesSandboxEnvironments({
                name: names.sandbox!,
              });
            expect(live.name).toEqual(names.sandbox);
            expect(live.displayName).toEqual(expected.displayName);
            expect(live.displayName).toContain("code");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!runSandboxes)("GetSandboxEnvironmentTemplate", () => {
      test.provider(
        "reads the sandbox environment template as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              displayName?: string;
            }>(baseUrl, "getSandboxEnvironmentTemplate");
            const expected =
              yield* aiplatform.getReasoningEnginesSandboxEnvironmentTemplates({
                name: names.template!,
              });
            expect(live.name).toEqual(names.template);
            expect(live.displayName).toEqual(expected.displayName);
            expect(live.displayName).toContain("browser");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!runSandboxPause)("PauseSandboxEnvironment", () => {
      test.provider(
        "pauses the sandbox environment as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "pauseSandboxEnvironment");
            const live = yield* aiplatform
              .getReasoningEnginesSandboxEnvironments({ name: names.paused! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (sandbox) => sandbox.state === "STATE_PAUSED",
                  times: 18,
                }),
              );
            expect(live.state).toEqual("STATE_PAUSED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!runSandboxPause)("ResumeSandboxEnvironment", () => {
      test.provider(
        "resumes a paused sandbox environment as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "resumeSandboxEnvironment");
            const live = yield* aiplatform
              .getReasoningEnginesSandboxEnvironments({ name: names.resumed! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (sandbox) => sandbox.state === "STATE_RUNNING",
                  times: 18,
                }),
              );
            expect(live.state).toEqual("STATE_RUNNING");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
