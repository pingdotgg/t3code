import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  datacatalog.getProjectsLocationsTaxonomies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTaxonomies on a missing taxonomy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.getProjectsLocationsTaxonomies({
          name: `projects/${project}/locations/${location}/taxonomies/alchemy-missing-taxonomy`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a taxonomy",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataCatalog.Taxonomy("Pii", {
            location,
            description: "taxonomy a",
            activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
          });
        }),
      );

      expect(created.name).toContain("/taxonomies/");
      expect(created.taxonomyId).toEqual(expect.any(String));
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual(expect.any(String));
      expect(created.description).toEqual("taxonomy a");
      expect(created.activatedPolicyTypes).toContain(
        "FINE_GRAINED_ACCESS_CONTROL",
      );

      const fetched = yield* datacatalog.getProjectsLocationsTaxonomies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("taxonomy a");
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataCatalog.Taxonomy("Pii", {
            location,
            displayName: created.displayName,
            description: "taxonomy b",
            activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual(created.displayName);
      expect(updated.description).toEqual("taxonomy b");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);
