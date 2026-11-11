import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as resourcemanagerV1 from "@distilled.cloud/gcp/unstable/cloudresourcemanager_v1";
import { adopt } from "alchemy/AdoptPolicy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
// Live create returns Forbidden: "The caller does not have permission"
// (resourcemanager.projects.create on the parent organization/folder).
// Set GOOGLE_ORGANIZATION_ID when the credentials can create projects there.
// Set GOOGLE_STANDALONE_PROJECTS=1 when the current project has no organization
// or folder and the credentials are a user's: Google rejects standalone
// project creation by service accounts.
const runStandalone = process.env.GOOGLE_STANDALONE_PROJECTS === "1";
const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID || runStandalone;

const waitUntilGone = (name: string) =>
  resourcemanager.getProjects({ name }).pipe(
    Effect.map((resource) =>
      resource.state === "DELETE_REQUESTED" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "ProjectNotFound"], () => Effect.succeed("gone" as const)),
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

      // Standalone when the current project has no organization or folder.
      const expectedParent = yield* resolveParent;
      if (runStandalone) expect(expectedParent).toBeUndefined();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            displayName: "Sandbox",
            labels: { env: "test", team: "infra" },
          });
        }),
      );

      expect(created.name).toMatch(/^projects\//);
      expect(created.projectId).toEqual(expect.any(String));
      expect(created.projectId.length).toBeGreaterThanOrEqual(6);
      expect(created.displayName).toEqual("Sandbox");
      expect(created.labels).toEqual({ env: "test", team: "infra" });
      expect(created.state).toEqual("ACTIVE");
      expect(created.parent).toEqual(expectedParent);

      const fetched = yield* resourcemanager.getProjects({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.projectId).toEqual(created.projectId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      // An unchanged redeploy keeps the project where it is.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            projectId: created.projectId,
            displayName: "Sandbox",
            labels: { env: "test" },
          });
        }),
      );
      expect(redeployed.name).toEqual(created.name);
      expect(redeployed.parent).toEqual(created.parent);

      // Lose state: reconcile re-observes the project by id instead of
      // failing for want of a parent.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Sandbox" });
      }).pipe(Effect.provide(stack.state));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            projectId: created.projectId,
            displayName: "Sandbox prod",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.displayName).toEqual("Sandbox prod");
      expect(updated.labels).toEqual({ env: "prod" });
      expect(updated.createTime).toEqual(created.createTime);
      expect(updated.parent).toEqual(created.parent);

      const fetchedUpdate = yield* resourcemanager.getProjects({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Sandbox prod");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.team).toBeUndefined();
      expect(fetchedUpdate.labels?.["alchemy-id"]).toEqual(expect.any(String));

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "adopting an unowned project requires opt-in and keeps its parent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            displayName: "Sandbox",
          });
        }),
      );

      // Strip Alchemy's ownership labels out of band and forget the state,
      // leaving a project Alchemy doesn't own. v1 `projects.update` replaces
      // labels; v3 `projects.patch` would only merge into them.
      const foreign = yield* resourcemanagerV1.getProjects({ projectId: created.projectId });
      yield* resourcemanagerV1.updateProjects({
        projectId: created.projectId,
        body: { ...foreign, labels: {} },
      });
      const stripped = yield* resourcemanager.getProjects({ name: created.name }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (resource) => resource.labels?.["alchemy-id"] === undefined,
          times: 10,
        }),
      );
      expect(stripped.labels?.["alchemy-id"]).toBeUndefined();
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Sandbox" });
      }).pipe(Effect.provide(stack.state));

      const project = Effect.gen(function* () {
        return yield* GCP.ResourceManager.Project("Sandbox", {
          projectId: created.projectId,
          displayName: "Adopted sandbox",
          labels: { env: "adopted" },
        });
      });
      const error = yield* stack.plan(project).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const adopted = yield* stack.deploy(project.pipe(adopt(true)));
      expect(adopted.name).toEqual(created.name);
      expect(adopted.parent).toEqual(created.parent);
      expect(adopted.displayName).toEqual("Adopted sandbox");
      expect(adopted.labels).toMatchObject({ env: "adopted" });
      const observed = yield* resourcemanager.getProjects({ name: adopted.name });
      expect(observed.labels?.["alchemy-id"]).toEqual(expect.any(String));

      yield* stack.destroy();
      expect(yield* waitUntilGone(adopted.name)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
