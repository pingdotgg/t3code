import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  location,
  logLevel,
  currentProject,
  runTagTemplateLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  datacatalog.getProjectsLocationsTagTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTagTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.getProjectsLocationsTagTemplates({
          name: `projects/${project}/locations/${location}/tagTemplates/alchemy_missing_template`,
        }),
      );
      expect(error._tag).toEqual("DataCatalogDeprecated");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runTagTemplateLifecycle)(
  "create is rejected with DataCatalogDeprecated",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datacatalog.createProjectsLocationsTagTemplates({
          parent: `projects/${project}/locations/${location}`,
          tagTemplateId: "alchemy_probe_template",
          body: {
            displayName: "probe",
            fields: {
              origin: { type: { primitiveType: "STRING" } },
            },
          },
        }),
      );
      expect(error._tag).toEqual("DataCatalogDeprecated");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runTagTemplateLifecycle)(
  "create, update, replace, and delete a tag template",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataCatalog.TagTemplate("Source", {
            location,
            displayName: "Source",
            fields: {
              origin: {
                displayName: "Origin",
                type: { primitiveType: "STRING" },
              },
            },
          });
        }),
      );

      expect(created.tagTemplateId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/tagTemplates/${created.tagTemplateId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("Source");
      expect(created.fields.origin?.displayName).toEqual("Origin");
      expect(created.fields.alchemy_ownership).toBeUndefined();

      const fetched = yield* datacatalog.getProjectsLocationsTagTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fields?.alchemy_ownership?.description).toContain(
        "alchemy-id=",
      );
      expect(fetched.fields?.origin?.displayName).toEqual("Origin");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataCatalog.TagTemplate("Source", {
            tagTemplateId: created.tagTemplateId,
            location,
            displayName: "Source v2",
            fields: {
              origin: {
                displayName: "Origin system",
                type: { primitiveType: "STRING" },
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Source v2");
      expect(updated.fields.origin?.displayName).toEqual("Origin system");

      const last = created.tagTemplateId.at(-1) ?? "a";
      const nextId = `${created.tagTemplateId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataCatalog.TagTemplate("Source", {
            tagTemplateId: nextId,
            location,
            displayName: "Source replaced",
            fields: {
              origin: {
                displayName: "Origin",
                type: { primitiveType: "STRING" },
              },
            },
          });
        }),
      );

      expect(replaced.tagTemplateId).not.toEqual(created.tagTemplateId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datacatalog", "live"],
    timeout: 90_000,
  },
);
