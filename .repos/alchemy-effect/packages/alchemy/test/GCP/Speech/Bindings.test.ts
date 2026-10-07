import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as speech from "@distilled.cloud/gcp/speech_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import SpeechBindingsHost, { Hints, Ships } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SpeechBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let customClassName: string;
let phraseSetName: string;

/**
 * Project-level roles (with their IAM Condition, if any) held by the
 * host's service account. Speech-to-Text has no resource-level IAM.
 */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
          )
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          })),
      ),
    );

describe.skipIf(!dockerAvailable)(
  "Speech Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:speech", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SpeechBindingsHost;
            const ships = yield* Ships;
            const hints = yield* Hints;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              customClass: ships.name,
              phraseSet: hints.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        customClassName = out.customClass;
        phraseSetName = out.phraseSet;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    // Every Speech binding grants the same unconditioned project role.
    const expectSpeechClientOnly = Effect.gen(function* () {
      expect(yield* projectRoles()).toEqual([
        { role: "roles/speech.client", condition: undefined },
      ]);
    });

    describe("GetCustomClass", () => {
      test.provider(
        "reads the bound custom class as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string; items: string[] }>(
              baseUrl,
              "getCustomClass",
            );
            expect(out.name).toEqual(customClassName);
            expect(out.items).toEqual(["sloop", "schooner"]);

            const live = yield* speech.getProjectsLocationsCustomClasses({
              name: customClassName,
            });
            expect(live.name).toEqual(out.name);
            yield* expectSpeechClientOnly;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:speech", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetPhraseSet", () => {
      test.provider(
        "reads the bound phrase set as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              phrases: string[];
            }>(baseUrl, "getPhraseSet");
            expect(out.name).toEqual(phraseSetName);
            expect(out.phrases).toEqual(["weather"]);

            const live = yield* speech.getProjectsLocationsPhraseSets({
              name: phraseSetName,
            });
            expect(live.name).toEqual(out.name);
            yield* expectSpeechClientOnly;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:speech", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Recognize", () => {
      test.provider(
        "recognizes audio adapted with the bound phrase set as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              results: unknown[];
              totalBilledTime: string;
            }>(baseUrl, "recognize");
            // Silence has nothing to transcribe, but the request is billed.
            expect(out.results).toEqual([]);
            expect(out.totalBilledTime).toMatch(/^\d+(\.\d+)?s$/);
            yield* expectSpeechClientOnly;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:speech", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
