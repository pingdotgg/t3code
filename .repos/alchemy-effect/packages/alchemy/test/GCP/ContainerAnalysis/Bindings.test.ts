import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { currentProject, TEST_RESOURCE_URI } from "./common.ts";
import ContainerAnalysisBindingsHost, {
  Authority,
  Signed,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ContainerAnalysisBindings");

let baseUrl: string;
let noteName: string;
let occurrenceName: string;
let hostAccount: string;

/** Roles the host's service account holds on the project policy. */
const projectRoles = Effect.gen(function* () {
  const project = yield* currentProject;
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }));
});

describe.skipIf(!dockerAvailable)(
  "ContainerAnalysis Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:containeranalysis",
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
            const host = yield* ContainerAnalysisBindingsHost;
            const note = yield* Authority;
            const occurrence = yield* Signed;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              note: note.name,
              occurrence: occurrence.name,
            };
          }),
        );
        baseUrl = out.uri!;
        noteName = out.note;
        occurrenceName = out.occurrence;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetNote", () => {
      test.provider(
        "reads the note as the host's service account, granted on the note only",
        (_stack) =>
          Effect.gen(function* () {
            const note = yield* expectProbe<containeranalysis.Note>(
              baseUrl,
              "getNote",
            );
            const live = yield* containeranalysis.getProjectsNotes({
              name: noteName,
            });
            expect(note.name).toEqual(noteName);
            expect(note.kind).toEqual("ATTESTATION");
            expect(note.shortDescription).toEqual(live.shortDescription);

            const policy = yield* containeranalysis.getIamPolicyProjectsNotes({
              resource: noteName,
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role);
            expect(roles).toEqual(["roles/containeranalysis.notes.viewer"]);
            expect(
              (yield* projectRoles).map((grant) => grant.role),
            ).not.toContain("roles/containeranalysis.notes.viewer");
          }),
        {
          tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetOccurrence", () => {
      test.provider(
        "reads the occurrence as the host's service account, granted on the project",
        (_stack) =>
          Effect.gen(function* () {
            const occurrence = yield* expectProbe<containeranalysis.Occurrence>(
              baseUrl,
              "getOccurrence",
            );
            const live = yield* containeranalysis.getProjectsOccurrences({
              name: occurrenceName,
            });
            expect(occurrence.name).toEqual(occurrenceName);
            expect(occurrence.noteName).toEqual(noteName);
            expect(occurrence.resourceUri).toEqual(TEST_RESOURCE_URI);
            expect(occurrence.createTime).toEqual(live.createTime);

            // Occurrence IAM is not modelled as a grant target, so the role is
            // granted on the project (no condition).
            expect(yield* projectRoles).toEqual([
              {
                role: "roles/containeranalysis.occurrences.viewer",
                condition: undefined,
              },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
