import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsTargetProjects on a missing target fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsTargetProjects({
          name: `projects/${project}/locations/global/targetProjects/alchemy-missing-target`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 90_000,
  },
);

// Migrate to VMs registers the host project as a target on first use, and a
// project can be a target only once (BadRequest "failed precondition: an
// existing target project exists for project ..."). Set
// GCP_TEST_VMMIGRATION_TARGET_PROJECT to a second project id to run this.
const targetProject = process.env.GCP_TEST_VMMIGRATION_TARGET_PROJECT;

test.provider.skipIf(!targetProject)(
  "create, update, and delete a vm migration target project",
  (stack) =>
    Effect.gen(function* () {
      const hostProject = yield* currentProject;
      const project = targetProject!;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMMigration.Target("Landing", {
            project,
            description: "landing zone",
          });
        }),
      );

      expect(created.targetProjectId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${hostProject}/locations/global/targetProjects/${created.targetProjectId}`,
      );
      expect(created.location).toEqual("global");
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("landing zone");

      const fetched = yield* vmmigration.getProjectsLocationsTargetProjects({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.project).toEqual(project);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("landing zone");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMMigration.Target("Landing", {
            targetProjectId: created.targetProjectId,
            project,
            description: "landing zone v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("landing zone v2");

      const fetchedUpdate =
        yield* vmmigration.getProjectsLocationsTargetProjects({
          name: updated.name,
        });
      expect(fetchedUpdate.description).toContain("landing zone v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsTargetProjects({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 90_000,
  },
);
