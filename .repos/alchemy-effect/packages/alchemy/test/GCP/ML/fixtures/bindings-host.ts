import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { type Probe, serveProbes } from "../../bindingHost.ts";
import { region, runVersionLifecycle } from "../common.ts";

export const Classifier = GCP.ML.Model("Classifier", {
  description: "binding probe",
  regions: [region],
});

/** Needs a trained SavedModel at GCP_TEST_ML_DEPLOYMENT_URI. */
export const V1 = Effect.gen(function* () {
  const model = yield* Classifier;
  return yield* GCP.ML.ModelsVersion("V1", {
    model: model.name,
    deploymentUri: process.env.GCP_TEST_ML_DEPLOYMENT_URI ?? "",
    runtimeVersion: "2.11",
    pythonVersion: "3.7",
    framework: "TENSORFLOW",
  });
});

/**
 * Effect-native Cloud Run service exercising every AI Platform (legacy ML)
 * binding as its own runtime service account. The version (and its
 * GetVersion binding) is only declared when `runVersionLifecycle` is set.
 * Deployed from {@link ../Bindings.test.ts}.
 */
export default class MlBindingsHost extends GCP.Function<MlBindingsHost>()(
  "MlBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const model = yield* Classifier;
    const getModel = yield* GCP.ML.GetModel(model);
    const predict = yield* GCP.ML.Predict(model);
    const versionRoutes: Record<string, Probe> = runVersionLifecycle
      ? { getVersion: (yield* GCP.ML.GetVersion(yield* V1))() }
      : {};

    return {
      fetch: serveProbes({
        getModel: getModel(),
        predict: predict({
          body: {
            httpBody: {
              contentType: "application/json",
              data: btoa(JSON.stringify({ instances: [{ f1: 1 }] })),
            },
          },
        }),
        ...versionRoutes,
      }),
    };
  }).pipe(
    Effect.provide(GCP.ML.GetModelHttp),
    Effect.provide(GCP.ML.PredictHttp),
    Effect.provide(GCP.ML.GetVersionHttp),
  ),
) {}
