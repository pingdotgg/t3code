import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsTemplates({
          name: `projects/${project}/locations/${location}/templates/alchemy-missing-template`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an integration template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.Template("Orders", {
            location,
            displayName: "order-sync",
            description: "sync orders",
            tags: ["orders"],
            categories: ["SALES_AND_MARKETING"],
            visibility: "PRIVATE",
          });
        }),
      );

      expect(created.templateId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/templates/${created.templateId}`,
      );
      expect(created.displayName).toEqual("order-sync");
      expect(created.description).toEqual("sync orders");
      expect(created.tags).toContain("orders");
      expect(created.categories).toContain("SALES_AND_MARKETING");
      expect(created.visibility).toEqual("PRIVATE");

      const fetched = yield* integrations.getProjectsLocationsTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.displayName).toEqual("order-sync");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.Template("Orders", {
            templateId: created.templateId,
            location,
            displayName: "order-sync-v2",
            description: "sync orders v2",
            tags: ["orders", "v2"],
            categories: ["SALES_AND_MARKETING", "UTILITY"],
            visibility: "PRIVATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("order-sync-v2");
      expect(updated.description).toEqual("sync orders v2");
      expect(updated.tags).toEqual(expect.arrayContaining(["orders", "v2"]));
      expect(updated.categories).toContain("UTILITY");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
