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
// Live create returns Forbidden: Permission 'resourcemanager.folders.create'
// denied on resource '//cloudresourcemanager.googleapis.com/organizations/531963060189'.
// Set GOOGLE_ORGANIZATION_ID when the credentials can create folders there.
const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

const waitUntilGone = (name: string) =>
  resourcemanager.getFolders({ name }).pipe(
    Effect.map((folder) =>
      folder.state === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "FolderNotFound"], () =>
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
  "getFolders on a missing folder fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        resourcemanager.getFolders({
          name: "folders/999999999999",
        }),
      );
      expect(error._tag).toEqual("FolderNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createFolders without folder IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent.pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      const error = yield* Effect.flip(
        resourcemanager.createFolders({
          body: {
            parent: parent ?? "organizations/0",
            displayName: "probe-folder",
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
  "create, update, and delete a folder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Folder("Team", {
            displayName: "platform",
          });
        }),
      );

      expect(created.name).toMatch(/^folders\//);
      expect(created.displayName).toEqual("platform");
      expect(created.parent).toMatch(/^(organizations|folders)\//);
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* resourcemanager.getFolders({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual(created.displayName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Folder("Team", {
            displayName: "platform-prod",
            parent: created.parent,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("platform-prod");
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* resourcemanager.getFolders({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("platform-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:resourcemanager", "live"],
    timeout: 90_000,
  },
);
