import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
// Live create returns Forbidden: "The caller does not have permission"
// (resourcemanager.projects.create on the parent organization/folder).
// Set GOOGLE_ORGANIZATION_ID when the credentials can create projects there.
const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

const waitUntilGone = (name: string) =>
  resourcemanager.getProjects({ name }).pipe(
    Effect.map((resource) =>
      resource.state === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "ProjectNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const resolveParent = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const resource = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  return resource.parent;
});

test.provider(
  "getProjects on a missing project fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        resourcemanager.getProjects({
          name: "projects/alchemy-missing-proj",
        }),
      );
      expect(error._tag).toEqual("ProjectNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjects without project-creator IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent.pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      const error = yield* Effect.flip(
        resourcemanager.createProjects({
          body: {
            projectId: "alchemy-rm-probe-xxxx",
            parent: parent ?? "organizations/0",
            displayName: "Alchemy Probe",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            displayName: "Sandbox",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toMatch(/^projects\//);
      expect(created.projectId).toEqual(expect.any(String));
      expect(created.projectId.length).toBeGreaterThanOrEqual(6);
      expect(created.displayName).toEqual("Sandbox");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* resourcemanager.getProjects({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.projectId).toEqual(created.projectId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            projectId: created.projectId,
            parent: created.parent,
            displayName: "Sandbox prod",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.displayName).toEqual("Sandbox prod");
      expect(updated.labels).toMatchObject({ env: "prod" });
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* resourcemanager.getProjects({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Sandbox prod");
      expect(fetchedUpdate.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
