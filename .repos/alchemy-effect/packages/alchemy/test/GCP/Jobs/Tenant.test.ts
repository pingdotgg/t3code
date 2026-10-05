import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  jobs.getProjectsTenants({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runLifecycle)(
  "getProjectsTenants on a missing tenant fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.getProjectsTenants({
          name: `projects/${project}/tenants/alchemy-missing-tenant`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsTenants fails with TalentDataPermissionRequired until onboarded",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.createProjectsTenants({
          parent: `projects/${project}`,
          body: { externalId: "alchemy-jobs-probe" },
        }),
      );
      expect(error._tag).toEqual("TalentDataPermissionRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a tenant",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Jobs.Tenant("Acme", {
            externalId: "acme-corp",
          });
        }),
      );

      expect(created.name.startsWith(`projects/${project}/tenants/`)).toEqual(
        true,
      );
      expect(created.tenantId.length).toBeGreaterThan(0);
      expect(created.externalId).toEqual("acme-corp");
      expect(created.project).toEqual(project);

      const fetched = yield* jobs.getProjectsTenants({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.externalId).toContain("[alchemy ");
      expect(fetched.externalId).toContain("acme-corp");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Jobs.Tenant("Acme", {
            tenantId: created.tenantId,
            externalId: "acme-holdings",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.externalId).toEqual("acme-holdings");

      const fetchedUpdate = yield* jobs.getProjectsTenants({
        name: created.name,
      });
      expect(fetchedUpdate.externalId).toContain("acme-holdings");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);
