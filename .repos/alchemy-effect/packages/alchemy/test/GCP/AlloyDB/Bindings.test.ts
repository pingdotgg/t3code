import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import AlloyDbBindingsHost, {
  AppUser,
  Db,
  Primary,
  Snapshot,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AlloyDbBindings");

// AlloyDB clusters and instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let names: { cluster: string; instance: string; backup: string; user: string };

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
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
      }))
      .sort((left, right) => (left.role ?? "").localeCompare(right.role ?? ""));
  });

/**
 * AlloyDB resources have no resource-level IAM policy: reads grant
 * alloydb.viewer and GetConnectionInfo alloydb.client, on the project.
 */
const PROJECT_GRANTS = [
  { role: "roles/alloydb.client", condition: undefined },
  { role: "roles/alloydb.viewer", condition: undefined },
];

const expectProjectGrants = Effect.gen(function* () {
  expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "AlloyDB Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* AlloyDbBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              names: {
                cluster: (yield* Db).name,
                instance: (yield* Primary).name,
                backup: (yield* Snapshot).name,
                user: (yield* AppUser).name,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        names = out.names;
      }),
      { timeout: 3_600_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 3_600_000 });

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{ name?: string; uid?: string }>(
              baseUrl,
              "getCluster",
            );
            const expected = yield* alloydb.getProjectsLocationsClusters({
              name: names.cluster,
            });
            expect(live.name).toEqual(names.cluster);
            expect(live.uid).toEqual(expected.uid);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{ name?: string; uid?: string }>(
              baseUrl,
              "getInstance",
            );
            const expected =
              yield* alloydb.getProjectsLocationsClustersInstances({
                name: names.instance,
              });
            expect(live.name).toEqual(names.instance);
            expect(live.uid).toEqual(expected.uid);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetConnectionInfo", () => {
      test.provider(
        "reads the instance's connection info as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              instanceUid?: string;
              ipAddress?: string;
            }>(baseUrl, "getConnectionInfo");
            const expected =
              yield* alloydb.getConnectionInfoProjectsLocationsClustersInstances(
                { parent: names.instance },
              );
            const instance =
              yield* alloydb.getProjectsLocationsClustersInstances({
                name: names.instance,
              });
            expect(live.instanceUid).toEqual(instance.uid);
            expect(live.instanceUid).toEqual(expect.any(String));
            expect(live.ipAddress).toEqual(expected.ipAddress);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetBackup", () => {
      test.provider(
        "reads the backup as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{ name?: string; uid?: string }>(
              baseUrl,
              "getBackup",
            );
            const expected = yield* alloydb.getProjectsLocationsBackups({
              name: names.backup,
            });
            expect(live.name).toEqual(names.backup);
            expect(live.uid).toEqual(expected.uid);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads the database user as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              databaseRoles?: string[];
            }>(baseUrl, "getUser");
            expect(live.name).toEqual(names.user);
            expect(live.databaseRoles).toContain("alloydbsuperuser");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
