import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { location, logLevel, currentParent, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsModels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const findDataset = (parent: string, displayName: string) =>
  translate.listProjectsLocationsDatasets.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
    Stream.filter((dataset) => dataset.displayName === displayName),
    Stream.runHead,
  );

/** An empty Translation dataset (no sentence pairs imported). */
const createEmptyDataset = (displayName: string) =>
  Effect.gen(function* () {
    const parent = yield* currentParent;
    const existing = yield* findDataset(parent, displayName);
    if (existing._tag === "Some" && existing.value.name) {
      return existing.value.name;
    }
    const operation = yield* translate.createProjectsLocationsDatasets({
      parent,
      body: {
        displayName,
        sourceLanguageCode: "en",
        targetLanguageCode: "es",
      },
    });
    yield* GCP.Translate.waitForOperation(operation);
    const created = yield* findDataset(parent, displayName);
    expect(created._tag).toEqual("Some");
    return created._tag === "Some" ? (created.value.name ?? "") : "";
  });

const deleteDataset = (name: string) =>
  translate.deleteProjectsLocationsDatasets({ name }).pipe(
    Effect.flatMap((operation) =>
      GCP.Translate.waitForOperation(operation, { notFoundOk: true }),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
  );

test.provider(
  "getProjectsLocationsModels on a missing model fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsModels({
          name: `${parent}/models/NM0000000000000000000`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "a model trained from an empty dataset fails with GCP.OperationFailed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dataset = yield* createEmptyDataset("alcemptymodelds");

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Translate.Model("Empty", {
              location,
              dataset,
              displayName: "empty",
            });
          }),
        ),
      );
      expect(error._tag).toEqual("GCP.OperationFailed");

      yield* stack.destroy();
      yield* deleteDataset(dataset);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:translate", "live"],
    timeout: 180_000,
  },
);

// Training a model needs a dataset with imported sentence pairs and takes
// hours. Point GCP_TEST_TRANSLATE_MODEL_DATASET at such a dataset.
const runModelLifecycle =
  runLifecycle &&
  process.env.GCP_TEST_TRANSLATE_MODEL === "1" &&
  !!process.env.GCP_TEST_TRANSLATE_MODEL_DATASET;

test.provider.skipIf(!runModelLifecycle)(
  "create and delete a translation model",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const dataset = process.env.GCP_TEST_TRANSLATE_MODEL_DATASET ?? "";

      const model = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.Model("EnEs", {
            location,
            dataset,
            displayName: "enes",
          });
        }),
      );
      expect(model.name).toContain("/models/");
      expect(model.location).toEqual(location);
      expect(model.displayName).toEqual("enes");

      const fetched = yield* translate.getProjectsLocationsModels({
        name: model.name,
      });
      expect(fetched.name).toEqual(model.name);
      expect(fetched.displayName).toEqual("enes");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(model.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:translate", "live"],
    timeout: 12 * 60 * 60_000,
  },
);
