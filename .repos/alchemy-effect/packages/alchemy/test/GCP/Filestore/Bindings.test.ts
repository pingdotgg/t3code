import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as file from "@distilled.cloud/gcp/file_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import FilestoreBindingsHost, {
  Nfs,
  Nightly,
} from "./fixtures/bindings-host.ts";
import FilestoreSnapshotBindingsHost, {
  Snap,
  ZonalNfs,
} from "./fixtures/snapshot-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FilestoreBindings");
const snapshotStack = Core.scratchStack(
  testOptions,
  "FilestoreSnapshotBindings",
);

// Filestore instances take 5–20 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;
// Snapshot-capable tiers draw on `EnterpriseStorageGibPerRegion`, which the
// testing project lacks (limit 0); InstancesSnapshot.test.ts pins the typed
// StorageQuotaExceeded rejection.
const runSnapshot = runLifecycle && !!process.env.GCP_TEST_FILESTORE_ENTERPRISE;

let baseUrl: string;
let hostAccount: string;
let instanceName: string;
let backupName: string;
let snapshotBaseUrl: string;
let snapshotHostAccount: string;
let snapshotName: string;

/**
 * Roles the host's service account holds on the project. Filestore has no
 * resource-level IAM, so its bindings grant `roles/file.viewer` there.
 */
const hostProjectRoles = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }));
  });

const expectedRoles = [{ role: "roles/file.viewer", condition: undefined }];

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "Filestore Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:filestore",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* FilestoreBindingsHost;
            const instance = yield* Nfs;
            const backup = yield* Nightly;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              instance: instance.name,
              backup: backup.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        instanceName = out.instance;
        backupName = out.backup;
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_800_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<file.Instance>(
              baseUrl,
              "getInstance",
            );
            const direct = yield* file.getProjectsLocationsInstances({
              name: instanceName,
            });
            expect(out.name).toEqual(instanceName);
            expect(out.tier).toEqual(direct.tier);
            expect(out.fileShares?.[0]?.name).toEqual("share1");
            expect(yield* hostProjectRoles(hostAccount)).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:filestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetBackup", () => {
      test.provider(
        "reads the backup as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<file.Backup>(baseUrl, "getBackup");
            const direct = yield* file.getProjectsLocationsBackups({
              name: backupName,
            });
            expect(out.name).toEqual(backupName);
            expect(out.sourceInstance).toEqual(direct.sourceInstance);
            expect(out.sourceFileShare).toEqual("share1");
            expect(yield* hostProjectRoles(hostAccount)).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:filestore", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);

describe.skipIf(!dockerAvailable || !runSnapshot)(
  "Filestore Bindings (enterprise quota)",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:filestore",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* snapshotStack.destroy();
        const out = yield* snapshotStack.deploy(
          Effect.gen(function* () {
            const host = yield* FilestoreSnapshotBindingsHost;
            yield* ZonalNfs;
            const snapshot = yield* Snap;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              snapshot: snapshot.name,
            };
          }),
        );
        snapshotBaseUrl = out.uri!;
        snapshotHostAccount = out.serviceAccount!;
        snapshotName = out.snapshot;
      }),
      { timeout: 1_800_000 },
    );

    afterAll(snapshotStack.destroy(), { timeout: 1_800_000 });

    describe("GetInstancesSnapshot", () => {
      test.provider(
        "reads the snapshot as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<file.Snapshot>(
              snapshotBaseUrl,
              "getInstancesSnapshot",
            );
            const direct = yield* file.getProjectsLocationsInstancesSnapshots({
              name: snapshotName,
            });
            expect(out.name).toEqual(snapshotName);
            expect(out.createTime).toEqual(direct.createTime);
            expect(yield* hostProjectRoles(snapshotHostAccount)).toEqual(
              expectedRoles,
            );
          }),
        {
          tags: ["provider:gcp", "provider:gcp:filestore", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
