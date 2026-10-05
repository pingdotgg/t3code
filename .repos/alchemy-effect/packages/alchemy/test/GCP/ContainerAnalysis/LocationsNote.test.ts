import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  containeranalysis.getProjectsLocationsNotes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsNotes on a missing note fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        containeranalysis.getProjectsLocationsNotes({
          name: `projects/${project}/locations/${location}/notes/alchemy-missing-note`,
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
  "create, update, and delete a locations note",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContainerAnalysis.LocationsNote("Authority", {
            location,
            shortDescription: "regional attestor",
            longDescription: "initial",
            attestation: { hint: { humanReadableName: "Alchemy Regional" } },
          });
        }),
      );

      expect(created.name).toContain(`/locations/${location}/notes/`);
      expect(created.location).toEqual(location);
      expect(created.shortDescription).toEqual("regional attestor");
      expect(created.kind).toEqual("ATTESTATION");

      const fetched = yield* containeranalysis.getProjectsLocationsNotes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.longDescription).toContain("[alchemy ");
      expect(fetched.kind).toEqual("ATTESTATION");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContainerAnalysis.LocationsNote("Authority", {
            noteId: created.noteId,
            location,
            shortDescription: "regional attestor v2",
            longDescription: "updated",
            attestation: { hint: { humanReadableName: "Alchemy Regional" } },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.shortDescription).toEqual("regional attestor v2");
      expect(updated.longDescription).toEqual("updated");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:containeranalysis", "live"],
    timeout: 90_000,
  },
);
