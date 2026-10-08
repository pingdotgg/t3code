import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  datacatalog.getProjectsLocationsTaxonomiesPolicyTags({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTaxonomiesPolicyTags on a missing tag fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.getProjectsLocationsTaxonomiesPolicyTags({
          name: `projects/${project}/locations/${location}/taxonomies/alchemy-missing/policyTags/alchemy-missing`,
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
  "create, update, and delete a policy tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const taxonomy = yield* GCP.DataCatalog.Taxonomy("Pii", {
            location,
            displayName: "pii taxonomy",
            description: "policy tag parent",
          });
          const tag = yield* GCP.DataCatalog.TaxonomiesPolicyTag("Email", {
            taxonomy: taxonomy.name,
            displayName: "email",
            description: "email addresses",
          });
          return { taxonomy, tag };
        }),
      );

      expect(created.tag.name).toContain("/policyTags/");
      expect(created.tag.taxonomy).toEqual(created.taxonomy.name);
      expect(created.tag.displayName).toEqual("email");
      expect(created.tag.description).toEqual("email addresses");
      expect(created.tag.parentPolicyTag).toBeUndefined();

      const fetched =
        yield* datacatalog.getProjectsLocationsTaxonomiesPolicyTags({
          name: created.tag.name,
        });
      expect(fetched.name).toEqual(created.tag.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("email addresses");
      expect(fetched.displayName).toEqual("email");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const taxonomy = yield* GCP.DataCatalog.Taxonomy("Pii", {
            location,
            displayName: created.taxonomy.displayName,
            description: "policy tag parent",
          });
          const tag = yield* GCP.DataCatalog.TaxonomiesPolicyTag("Email", {
            taxonomy: taxonomy.name,
            displayName: "email v2",
            description: "email addresses v2",
          });
          return { taxonomy, tag };
        }),
      );

      expect(updated.tag.name).toEqual(created.tag.name);
      expect(updated.tag.displayName).toEqual("email v2");
      expect(updated.tag.description).toEqual("email addresses v2");
      expect(updated.taxonomy.name).toEqual(created.taxonomy.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.tag.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);
