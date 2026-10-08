import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probe,
  currentProject,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsEvaluationJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        probe(
          datalabeling.getProjectsEvaluationJobs({
            name: `projects/${project}/evaluationJobs/alchemy-missing-job`,
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an evaluation job",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const specs = yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
            displayName: "pets",
            annotationSpecs: [{ displayName: "dog" }, { displayName: "cat" }],
          });
          const job = yield* GCP.DataLabeling.EvaluationJob("DailyEval", {
            annotationSpecSet: specs.name,
            modelVersion: `projects/${project}/models/classifier/versions/v1`,
            schedule: "every 24 hours",
            description: "daily sample",
            evaluationJobConfig: {
              exampleCount: 50,
              exampleSamplePercentage: 0.1,
              evaluationConfig: {},
              inputConfig: {
                dataType: "IMAGE",
                annotationType: "IMAGE_CLASSIFICATION_ANNOTATION",
                classificationMetadata: { isMultiLabel: false },
                bigquerySource: {
                  inputUri: `bq://${project}.eval.predictions`,
                },
              },
              bigqueryImportKeys: {
                data_json_key: "data",
                label_json_key: "label",
                label_score_json_key: "score",
              },
              imageClassificationConfig: {
                annotationSpecSet: specs.name,
              },
            },
          });
          return { specs, job };
        }),
      );

      expect(created.job.name).toContain("/evaluationJobs/");
      expect(created.job.annotationSpecSet).toEqual(created.specs.name);
      expect(created.job.description).toEqual("daily sample");
      expect(created.job.evaluationJobConfig?.exampleCount).toEqual(50);

      const fetched = yield* datalabeling.getProjectsEvaluationJobs({
        name: created.job.name,
      });
      expect(fetched.name).toEqual(created.job.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const specs = yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
            annotationSpecSetId: created.specs.annotationSpecSetId,
            displayName: "pets",
            annotationSpecs: [{ displayName: "dog" }, { displayName: "cat" }],
          });
          const job = yield* GCP.DataLabeling.EvaluationJob("DailyEval", {
            evaluationJobId: created.job.evaluationJobId,
            annotationSpecSet: specs.name,
            modelVersion: created.job.modelVersion ?? "",
            schedule: created.job.schedule ?? "every 24 hours",
            description: "daily sample",
            evaluationJobConfig: {
              ...created.job.evaluationJobConfig,
              exampleCount: 80,
              exampleSamplePercentage: 0.2,
              imageClassificationConfig: {
                annotationSpecSet: specs.name,
              },
            },
          });
          return { specs, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.evaluationJobConfig?.exampleCount).toEqual(80);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datalabeling.getProjectsEvaluationJobs({ name: created.job.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);
