import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as orgpolicy from "@distilled.cloud/gcp/orgpolicy_v2";
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

const waitUntilGone = (name: string) =>
  orgpolicy.getOrganizationsCustomConstraints({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            )
          : undefined;
    }
    return "";
  });

const probeCreate = (parent: string) =>
  orgpolicy.createOrganizationsCustomConstraints({
    parent,
    body: {
      name: `${parent}/customConstraints/custom.alchemyMissingProbe`,
      resourceTypes: ["compute.googleapis.com/Instance"],
      methodTypes: ["CREATE"],
      condition: "resource.name.startsWith('alchemy-probe-')",
      actionType: "DENY",
      displayName: "alchemy probe",
    },
  });

test.provider(
  "getOrganizationsCustomConstraints on a missing constraint fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        orgpolicy.getOrganizationsCustomConstraints({
          name: `${organization}/customConstraints/custom.alchemyDoesNotExist`,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"], timeout: 90_000 },
);

// Custom constraints need Organization Policy Administrator on the org; the
// testing credentials get Forbidden (probe). Set GOOGLE_ORGANIZATION_ID when
// the credentials administer the org to run the lifecycle.
const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

test.provider.skipIf(runLifecycle)(
  "createOrganizationsCustomConstraints without org policy admin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(probeCreate(organization));
      expect(error._tag).toEqual("Forbidden");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete an organization custom constraint",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const organization = yield* organizationOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
            organization,
            resourceTypes: ["compute.googleapis.com/Instance"],
            methodTypes: ["CREATE"],
            condition: "resource.name.startsWith('test-')",
            actionType: "DENY",
            displayName: "Deny test VMs",
            description: "blocks test-prefixed instances",
          });
        }),
      );

      expect(created.constraintId.startsWith("custom.")).toEqual(true);
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/customConstraints/${created.constraintId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.resourceTypes).toEqual([
        "compute.googleapis.com/Instance",
      ]);
      expect(created.methodTypes).toEqual(["CREATE"]);
      expect(created.condition).toEqual("resource.name.startsWith('test-')");
      expect(created.actionType).toEqual("DENY");
      expect(created.displayName).toEqual("Deny test VMs");
      expect(created.description).toEqual("blocks test-prefixed instances");

      const fetched = yield* orgpolicy.getOrganizationsCustomConstraints({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.condition).toEqual(created.condition);
      expect(fetched.actionType).toEqual("DENY");
      expect(fetched.description ?? "").toContain(
        "blocks test-prefixed instances",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
            organization,
            constraintId: created.constraintId,
            resourceTypes: ["compute.googleapis.com/Instance"],
            methodTypes: ["CREATE", "UPDATE"],
            condition: "resource.name.startsWith('tmp-')",
            actionType: "DENY",
            displayName: "Deny tmp VMs",
            description: "blocks tmp-prefixed instances",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.constraintId).toEqual(created.constraintId);
      expect(updated.methodTypes).toEqual(["CREATE", "UPDATE"]);
      expect(updated.condition).toEqual("resource.name.startsWith('tmp-')");
      expect(updated.displayName).toEqual("Deny tmp VMs");
      expect(updated.description).toEqual("blocks tmp-prefixed instances");

      const fetchedUpdate = yield* orgpolicy.getOrganizationsCustomConstraints({
        name: updated.name,
      });
      expect(fetchedUpdate.condition).toEqual(updated.condition);
      expect(fetchedUpdate.methodTypes).toEqual(["CREATE", "UPDATE"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.CustomConstraint("NoTestVms", {
            organization,
            constraintId: `${created.constraintId}.b`,
            resourceTypes: ["compute.googleapis.com/Instance"],
            methodTypes: ["CREATE"],
            condition: "resource.name.startsWith('tmp-')",
            actionType: "DENY",
            displayName: "Deny tmp VMs",
          });
        }),
      );

      expect(replaced.constraintId).toEqual(`${created.constraintId}.b`);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.name).toContain(
        `/customConstraints/${replaced.constraintId}`,
      );

      const fetchedReplace = yield* orgpolicy.getOrganizationsCustomConstraints(
        {
          name: replaced.name,
        },
      );
      expect(fetchedReplace.name).toEqual(replaced.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"], timeout: 90_000 },
);
