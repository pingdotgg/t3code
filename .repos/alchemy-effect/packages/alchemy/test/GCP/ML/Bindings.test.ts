import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as ml from "@distilled.cloud/gcp/ml_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { runLifecycle, runVersionLifecycle } from "./common.ts";
import MlBindingsHost, { Classifier, V1 } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MlBindings");

let baseUrl: string;
let hostAccount: string;
let modelName: string;
let versionName: string | undefined;

/** Every binding grants `roles/ml.modelUser` on the (parent) model only. */
const expectModelGrant = Effect.gen(function* () {
  const policy = yield* ml.getIamPolicyProjectsModels({
    resource: modelName,
    "options.requestedPolicyVersion": 3,
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role);
  expect(roles).toEqual(["roles/ml.modelUser"]);
});

// ml.googleapis.com is deprecated; see ./common.ts for the gates.
describe.skipIf(!dockerAvailable || !runLifecycle)(
  "ML Bindings",
  { tags: ["provider:gcp", "provider:gcp:ml", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* MlBindingsHost;
            const model = yield* Classifier;
            const version = runVersionLifecycle ? yield* V1 : undefined;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              model: model.name,
              version: version?.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        modelName = out.model;
        versionName = out.version;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetModel", () => {
      test.provider(
        "reads the model as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<ml.GoogleCloudMlV1__Model>(
              baseUrl,
              "getModel",
            );
            const direct = yield* ml.getProjectsModels({ name: modelName });
            expect(out.name).toEqual(modelName);
            expect(out.description).toEqual("binding probe");
            expect(out.etag).toEqual(direct.etag);
            yield* expectModelGrant;
          }),
        { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 600_000 },
      );
    });

    // Prediction needs a deployed (default) version.
    describe.skipIf(!runVersionLifecycle)("Predict", () => {
      test.provider(
        "predicts against the model's default version",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<ml.GoogleApi__HttpBody>(
              baseUrl,
              "predict",
            );
            const body = JSON.parse(
              Buffer.from(out.data ?? "", "base64").toString("utf8"),
            ) as { predictions?: unknown[] };
            expect(body.predictions).toHaveLength(1);
            const model = yield* ml.getProjectsModels({ name: modelName });
            expect(model.defaultVersion?.name).toEqual(versionName);
            yield* expectModelGrant;
          }),
        { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 600_000 },
      );
    });

    describe.skipIf(!runVersionLifecycle)("GetVersion", () => {
      test.provider(
        "reads the version as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<ml.GoogleCloudMlV1__Version>(
              baseUrl,
              "getVersion",
            );
            const direct = yield* ml.getProjectsModelsVersions({
              name: versionName!,
            });
            expect(out.name).toEqual(versionName);
            expect(out.state).toEqual(direct.state);
            yield* expectModelGrant;
          }),
        { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 600_000 },
      );
    });
  },
);
