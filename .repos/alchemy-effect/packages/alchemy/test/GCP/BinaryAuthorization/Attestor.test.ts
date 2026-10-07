import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  currentProject,
  TEST_PKIX_PUBLIC_KEY_PEM,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  binaryauthorization.getProjectsAttestors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsAttestors on a missing attestor fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        binaryauthorization.getProjectsAttestors({
          name: `projects/${project}/attestors/alchemy-missing-attestor`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an attestor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.ContainerAnalysis.Note("Authority", {
            shortDescription: "alchemy binauthz attestor",
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
          const attestor = yield* GCP.BinaryAuthorization.Attestor("Qa", {
            noteReference: note.name,
            description: "initial",
          });
          return { note, attestor };
        }),
      );

      expect(created.attestor.name).toContain("/attestors/");
      expect(created.attestor.attestorId).toEqual(expect.any(String));
      expect(created.attestor.description).toEqual("initial");
      expect(created.attestor.noteReference).toEqual(created.note.name);
      expect(created.attestor.publicKeys).toEqual([]);

      const fetched = yield* binaryauthorization.getProjectsAttestors({
        name: created.attestor.name,
      });
      expect(fetched.name).toEqual(created.attestor.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("initial");
      expect(fetched.userOwnedGrafeasNote?.noteReference).toEqual(
        created.note.name,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.ContainerAnalysis.Note("Authority", {
            noteId: created.note.noteId,
            shortDescription: "alchemy binauthz attestor",
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
          const attestor = yield* GCP.BinaryAuthorization.Attestor("Qa", {
            attestorId: created.attestor.attestorId,
            noteReference: note.name,
            description: "updated",
            publicKeys: [
              {
                comment: "ci",
                pkixPublicKey: {
                  publicKeyPem: TEST_PKIX_PUBLIC_KEY_PEM,
                  signatureAlgorithm: "EC_SIGN_P256_SHA256",
                },
              },
            ],
          });
          return { note, attestor };
        }),
      );

      expect(updated.attestor.name).toEqual(created.attestor.name);
      expect(updated.attestor.description).toEqual("updated");
      expect(updated.attestor.publicKeys.length).toEqual(1);
      expect(updated.attestor.publicKeys[0]?.comment).toEqual("ci");

      const fetchedUpdate = yield* binaryauthorization.getProjectsAttestors({
        name: updated.attestor.name,
      });
      expect(fetchedUpdate.description).toContain("updated");
      expect(fetchedUpdate.userOwnedGrafeasNote?.publicKeys?.length).toEqual(1);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.attestor.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
    timeout: 90_000,
  },
);
