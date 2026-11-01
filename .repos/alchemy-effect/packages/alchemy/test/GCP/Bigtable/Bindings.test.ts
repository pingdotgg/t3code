import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import BigtableBindingsHost, {
  Db,
  Nodes,
  Rows,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BigtableBindings");

let baseUrl: string;
let hostAccount: string;
let instanceName: string;
let clusterName: string;
let tableName: string;

const hostRoles = (policy: bigtable.Policy) =>
  (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();

/** GetInstance and GetCluster grant bigtable.viewer on the instance only. */
const expectInstanceGrants = Effect.gen(function* () {
  const policy = yield* bigtable.getIamPolicyProjectsInstances({
    resource: instanceName,
    body: {},
  });
  expect(hostRoles(policy)).toEqual(["roles/bigtable.viewer"]);
});

/** GetTable grants bigtable.viewer on the table only. */
const expectTableGrants = Effect.gen(function* () {
  const policy = yield* bigtable.getIamPolicyProjectsInstancesTables({
    resource: tableName,
    body: {},
  });
  expect(hostRoles(policy)).toEqual(["roles/bigtable.viewer"]);
});

describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "Bigtable Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:bigtable", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigtableBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              instance: (yield* Db).name,
              cluster: (yield* Nodes).name,
              table: (yield* Rows).name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        instanceName = out.instance;
        clusterName = out.cluster;
        tableName = out.table;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account, granted on the instance only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Instance>(
              baseUrl,
              "getInstance",
            );
            const actual = yield* bigtable.getProjectsInstances({
              name: instanceName,
            });
            expect(live.name).toEqual(instanceName);
            expect(live.displayName).toEqual(actual.displayName);
            expect(live.state).toEqual("READY");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account, granted on the instance only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Cluster>(
              baseUrl,
              "getCluster",
            );
            expect(live.name).toEqual(clusterName);
            expect(live.serveNodes).toEqual(1);
            expect(live.defaultStorageType).toEqual("HDD");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetTable", () => {
      test.provider(
        "reads the table as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Table>(
              baseUrl,
              "getTable",
            );
            expect(live.name).toEqual(tableName);
            expect(Object.keys(live.columnFamilies ?? {})).toEqual(["cf"]);
            yield* expectTableGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
