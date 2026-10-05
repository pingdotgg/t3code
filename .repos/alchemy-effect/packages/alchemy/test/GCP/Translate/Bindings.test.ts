import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as translate from "@distilled.cloud/gcp/translate_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { callProbe, dockerAvailable, expectProbe } from "../bindingHost.ts";
import TranslateBindingsHost, {
  Dataset,
  EnEs,
  glossaryName,
  Hello,
  modelDataset,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TranslateBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let datasetName: string;
let modelName: string | undefined;
let entryName: string | undefined;

/**
 * Translation resources have no per-resource IAM policy: getters grant
 * `roles/cloudtranslate.viewer` and translate calls
 * `roles/cloudtranslate.user`, both on the project.
 */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({ role: binding.role, condition: binding.condition }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(roles).toEqual([
    { role: "roles/cloudtranslate.user", condition: undefined },
    { role: "roles/cloudtranslate.viewer", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable)(
  "Translate Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:translate",
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
            const host = yield* TranslateBindingsHost;
            const dataset = yield* Dataset;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              dataset: dataset.name,
              project: dataset.project,
              model: modelDataset ? (yield* EnEs).name : undefined,
              entry: glossaryName ? (yield* Hello).name : undefined,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        datasetName = out.dataset;
        project = out.project;
        modelName = out.model;
        entryName = out.entry;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetAdaptiveMtDataset", () => {
      test.provider(
        "reads the dataset as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<translate.AdaptiveMtDataset>(
              baseUrl,
              "getAdaptiveMtDataset",
            );
            expect(live.name).toEqual(datasetName);
            expect(live.sourceLanguageCode).toEqual("en");
            expect(live.targetLanguageCode).toEqual("es");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:translate", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("AdaptiveMtTranslate", () => {
      test.provider(
        "reaches the API as the host's service account (empty dataset is rejected as too small)",
        (_stack) =>
          Effect.gen(function* () {
            // The dataset has no sentence pairs, so an authorized call gets
            // the typed "fewer than 5 sentences" rejection.
            const outcome = yield* callProbe(baseUrl, "adaptiveMtTranslate");
            expect(outcome.ok ? "ok" : outcome.error._tag).toEqual(
              "AdaptiveMtDatasetTooSmall",
            );
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:translate", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!modelDataset)("GetModel", () => {
      test.provider(
        "reads the model as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<translate.Model>(
              baseUrl,
              "getModel",
            );
            expect(live.name).toEqual(modelName);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:translate", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!modelDataset)("TranslateText", () => {
      test.provider(
        "translates with the model as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<translate.TranslateTextResponse>(
              baseUrl,
              "translateText",
            );
            expect(out.translations?.length).toEqual(1);
            expect(out.translations?.[0]?.translatedText).toBeTruthy();
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:translate", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!glossaryName)("GetGlossariesGlossaryEntry", () => {
      test.provider(
        "reads the glossary entry as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<translate.GlossaryEntry>(
              baseUrl,
              "getGlossaryEntry",
            );
            expect(live.name).toEqual(entryName);
            expect(live.termsPair?.targetTerm?.text).toEqual("hola");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:translate", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
