import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  containeranalysis.getProjectsNotes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsNotes on a missing note fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        containeranalysis.getProjectsNotes({
          name: `projects/${project}/notes/alchemy-missing-note`,
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
  "create, update, and delete a note",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContainerAnalysis.Note("Authority", {
            shortDescription: "alchemy test attestor",
            longDescription: "initial",
            relatedUrl: [
              { url: "https://example.com/policy", label: "policy" },
            ],
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
        }),
      );

      expect(created.name).toContain("/notes/");
      expect(created.noteId).toEqual(expect.any(String));
      expect(created.shortDescription).toEqual("alchemy test attestor");
      expect(created.longDescription).toEqual("initial");
      expect(created.kind).toEqual("ATTESTATION");
      expect(created.attestation?.hint?.humanReadableName).toEqual(
        "Alchemy QA",
      );

      const fetched = yield* containeranalysis.getProjectsNotes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.shortDescription).toEqual("alchemy test attestor");
      expect(fetched.longDescription).toContain("[alchemy ");
      expect(fetched.longDescription).toContain("initial");
      expect(fetched.kind).toEqual("ATTESTATION");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContainerAnalysis.Note("Authority", {
            noteId: created.noteId,
            shortDescription: "alchemy test attestor v2",
            longDescription: "updated",
            relatedUrl: [
              { url: "https://example.com/policy", label: "policy" },
              { url: "https://example.com/docs", label: "docs" },
            ],
            attestation: { hint: { humanReadableName: "Alchemy QA" } },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.shortDescription).toEqual("alchemy test attestor v2");
      expect(updated.longDescription).toEqual("updated");
      expect(updated.relatedUrl.length).toBeGreaterThanOrEqual(1);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
    timeout: 90_000,
  },
);
