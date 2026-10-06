import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  currentProject,
  TEST_ATTESTATION,
  TEST_RESOURCE_URI,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  containeranalysis.getProjectsOccurrences({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsOccurrences on a missing occurrence fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        containeranalysis.getProjectsOccurrences({
          name: `projects/${project}/occurrences/alchemy-missing-occurrence`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an occurrence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.ContainerAnalysis.Note("Authority", {
            shortDescription: "occurrence attestor",
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
          const occurrence = yield* GCP.ContainerAnalysis.Occurrence("Signed", {
            noteName: note.name,
            resourceUri: TEST_RESOURCE_URI,
            remediation: "initial",
            attestation: TEST_ATTESTATION,
          });
          return { note, occurrence };
        }),
      );

      expect(created.occurrence.name).toContain("/occurrences/");
      expect(created.occurrence.noteName).toEqual(created.note.name);
      expect(created.occurrence.resourceUri).toEqual(TEST_RESOURCE_URI);
      expect(created.occurrence.remediation).toEqual("initial");
      expect(created.occurrence.kind).toEqual("ATTESTATION");

      const fetched = yield* containeranalysis.getProjectsOccurrences({
        name: created.occurrence.name,
      });
      expect(fetched.name).toEqual(created.occurrence.name);
      expect(fetched.noteName).toEqual(created.note.name);
      expect(fetched.resourceUri).toEqual(TEST_RESOURCE_URI);
      expect(fetched.remediation).toContain("[alchemy ");
      expect(fetched.kind).toEqual("ATTESTATION");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.ContainerAnalysis.Note("Authority", {
            noteId: created.note.noteId,
            shortDescription: "occurrence attestor",
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
          const occurrence = yield* GCP.ContainerAnalysis.Occurrence("Signed", {
            noteName: note.name,
            resourceUri: TEST_RESOURCE_URI,
            remediation: "rebuild from a patched base",
            attestation: TEST_ATTESTATION,
          });
          return { note, occurrence };
        }),
      );

      expect(updated.occurrence.name).toEqual(created.occurrence.name);
      expect(updated.occurrence.remediation).toEqual(
        "rebuild from a patched base",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.occurrence.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
    timeout: 90_000,
  },
);
