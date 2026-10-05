import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentParent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsAdaptiveMtDatasets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAdaptiveMtDatasets on a missing dataset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsAdaptiveMtDatasets({
          name: `${parent}/adaptiveMtDatasets/alchemy-missing-dataset`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete an Adaptive MT dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
            location,
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
            displayName: "enes",
          });
        }),
      );

      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.name).toContain("/adaptiveMtDatasets/");
      expect(created.location).toEqual(location);
      expect(created.sourceLanguageCode).toEqual("en");
      expect(created.targetLanguageCode).toEqual("es");
      expect(created.displayName).toEqual("enes");

      const fetched = yield* translate.getProjectsLocationsAdaptiveMtDatasets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.sourceLanguageCode).toEqual("en");
      expect(fetched.targetLanguageCode).toEqual("es");
      expect(fetched.displayName).toEqual("enes");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
            datasetId: created.datasetId,
            location,
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
            displayName: "enes",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.sourceLanguageCode).toEqual("en");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);
