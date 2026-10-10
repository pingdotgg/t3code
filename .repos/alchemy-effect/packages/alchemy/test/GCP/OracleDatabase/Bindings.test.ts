import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import OracleBindingsHost, {
  AppDb,
  Assign,
  BaseDb,
  Client,
  Exa,
  ExaVm,
  OracleNet,
  Replicat,
  Src,
  Vault,
  Vms,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "OracleBindings");

// Oracle Database@Google Cloud is not enabled in the test project
// (ServiceDisabled) and needs an Oracle Cloud subscription. Set
// GCP_TEST_ORACLE=1 in a project that has one.
const runLifecycle = !!process.env.GCP_TEST_ORACLE && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let names: Record<
  | "network"
  | "subnet"
  | "database"
  | "infra"
  | "vmCluster"
  | "dbSystem"
  | "vault"
  | "exadb"
  | "connection"
  | "deployment"
  | "assignment",
  string
>;

const ADB_ADMIN = "roles/oracledatabase.autonomousDatabaseAdmin";

/** Every role the host's bindings grant (project-level, unconditional). */
const expectedRoles = [
  ADB_ADMIN,
  "roles/oracledatabase.autonomousDatabaseViewer",
  "roles/oracledatabase.cloudExadataInfrastructureViewer",
  "roles/oracledatabase.cloudVmClusterViewer",
  "roles/oracledatabase.dbSystemViewer",
  "roles/oracledatabase.exadbVmClusterViewer",
  "roles/oracledatabase.exascaleDbStorageVaultViewer",
  "roles/oracledatabase.goldenGateConnectionAssignmentViewer",
  "roles/oracledatabase.goldenGateConnectionViewer",
  "roles/oracledatabase.goldenGateDeploymentViewer",
  "roles/oracledatabase.odbNetworkViewer",
  "roles/oracledatabase.odbSubnetViewer",
].sort();

/**
 * Oracle Database@Google Cloud has no resource-level IAM: each binding
 * grants its role on the project, unconditionally.
 */
const expectProjectGrant = (role: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    const grants = (policy.bindings ?? []).filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    );
    expect(grants.every((binding) => binding.condition === undefined)).toBe(
      true,
    );
    const roles = grants.map((binding) => binding.role ?? "").sort();
    expect(roles).toContain(role);
    expect(roles).toEqual(expectedRoles);
  });

/** Poll the autonomous database until it reaches `state` (bounded). */
const waitForDatabaseState = (state: string) =>
  oracle.getProjectsLocationsAutonomousDatabases({ name: names.database }).pipe(
    Effect.map((db) => db.properties?.state),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (current) => current === state,
      times: 54,
    }),
  );

/** A read-only `Get*` binding: probe, compare with a direct read. */
const describeGet = <A extends { name?: string }>(options: {
  binding: string;
  route: string;
  role: string;
  name: () => string;
  direct: (name: string) => Effect.Effect<A, { readonly _tag: string }, any>;
}) =>
  describe(options.binding, () => {
    test.provider(
      "reads the resource as the host's service account",
      (_stack) =>
        Effect.gen(function* () {
          const out = yield* expectProbe<A>(baseUrl, options.route);
          const direct = yield* options.direct(options.name());
          expect(out.name).toEqual(options.name());
          expect(out.name).toEqual(direct.name);
          yield* expectProjectGrant(options.role);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
        timeout: 600_000,
      },
    );
  });

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "OracleDatabase Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:oracledatabase",
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
            const host = yield* OracleBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              network: (yield* OracleNet).name,
              subnet: (yield* Client).name,
              database: (yield* AppDb).name,
              infra: (yield* Exa).name,
              vmCluster: (yield* Vms).name,
              dbSystem: (yield* BaseDb).name,
              vault: (yield* Vault).name,
              exadb: (yield* ExaVm).name,
              connection: (yield* Src).name,
              deployment: (yield* Replicat).name,
              assignment: (yield* Assign).name,
            };
          }),
        );
        const { uri, serviceAccount, ...rest } = out;
        baseUrl = uri!;
        hostAccount = serviceAccount!;
        names = rest;
      }),
      { timeout: 3_600_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 3_600_000 });

    describeGet({
      binding: "GetOdbNetwork",
      route: "getOdbNetwork",
      role: "roles/oracledatabase.odbNetworkViewer",
      name: () => names.network,
      direct: (name) => oracle.getProjectsLocationsOdbNetworks({ name }),
    });
    describeGet({
      binding: "GetOdbNetworksOdbSubnet",
      route: "getOdbNetworksOdbSubnet",
      role: "roles/oracledatabase.odbSubnetViewer",
      name: () => names.subnet,
      direct: (name) =>
        oracle.getProjectsLocationsOdbNetworksOdbSubnets({ name }),
    });
    describeGet({
      binding: "GetAutonomousDatabase",
      route: "getAutonomousDatabase",
      role: "roles/oracledatabase.autonomousDatabaseViewer",
      name: () => names.database,
      direct: (name) =>
        oracle.getProjectsLocationsAutonomousDatabases({ name }),
    });
    describeGet({
      binding: "GetCloudExadataInfrastructure",
      route: "getCloudExadataInfrastructure",
      role: "roles/oracledatabase.cloudExadataInfrastructureViewer",
      name: () => names.infra,
      direct: (name) =>
        oracle.getProjectsLocationsCloudExadataInfrastructures({ name }),
    });
    describeGet({
      binding: "GetCloudVmCluster",
      route: "getCloudVmCluster",
      role: "roles/oracledatabase.cloudVmClusterViewer",
      name: () => names.vmCluster,
      direct: (name) => oracle.getProjectsLocationsCloudVmClusters({ name }),
    });
    describeGet({
      binding: "GetDbSystem",
      route: "getDbSystem",
      role: "roles/oracledatabase.dbSystemViewer",
      name: () => names.dbSystem,
      direct: (name) => oracle.getProjectsLocationsDbSystems({ name }),
    });
    describeGet({
      binding: "GetExascaleDbStorageVault",
      route: "getExascaleDbStorageVault",
      role: "roles/oracledatabase.exascaleDbStorageVaultViewer",
      name: () => names.vault,
      direct: (name) =>
        oracle.getProjectsLocationsExascaleDbStorageVaults({ name }),
    });
    describeGet({
      binding: "GetExadbVmCluster",
      route: "getExadbVmCluster",
      role: "roles/oracledatabase.exadbVmClusterViewer",
      name: () => names.exadb,
      direct: (name) => oracle.getProjectsLocationsExadbVmClusters({ name }),
    });
    describeGet({
      binding: "GetGoldengateConnection",
      route: "getGoldengateConnection",
      role: "roles/oracledatabase.goldenGateConnectionViewer",
      name: () => names.connection,
      direct: (name) =>
        oracle.getProjectsLocationsGoldengateConnections({ name }),
    });
    describeGet({
      binding: "GetGoldengateDeployment",
      route: "getGoldengateDeployment",
      role: "roles/oracledatabase.goldenGateDeploymentViewer",
      name: () => names.deployment,
      direct: (name) =>
        oracle.getProjectsLocationsGoldengateDeployments({ name }),
    });
    describeGet({
      binding: "GetGoldengateConnectionAssignment",
      route: "getGoldengateConnectionAssignment",
      role: "roles/oracledatabase.goldenGateConnectionAssignmentViewer",
      name: () => names.assignment,
      direct: (name) =>
        oracle.getProjectsLocationsGoldengateConnectionAssignments({ name }),
    });

    // Wallet → Stop → Start → Restart act on one database: run in order.
    describe.sequential("AutonomousDatabase actions", () => {
      describe("GenerateWallet", () => {
        test.provider(
          "generates the database wallet as the host's service account",
          (_stack) =>
            Effect.gen(function* () {
              const out =
                yield* expectProbe<oracle.GenerateAutonomousDatabaseWalletResponse>(
                  baseUrl,
                  "generateWallet",
                );
              // The wallet is a base64 zip archive ("PK" magic).
              const archive = Buffer.from(out.archiveContent ?? "", "base64");
              expect(archive.subarray(0, 2).toString("latin1")).toEqual("PK");
              yield* expectProjectGrant(ADB_ADMIN);
            }),
          {
            tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
            timeout: 600_000,
          },
        );
      });

      describe("StopAutonomousDatabase", () => {
        test.provider(
          "stops the database as the host's service account",
          (_stack) =>
            Effect.gen(function* () {
              yield* expectProbe(baseUrl, "stopAutonomousDatabase");
              expect(yield* waitForDatabaseState("STOPPED")).toEqual("STOPPED");
              yield* expectProjectGrant(ADB_ADMIN);
            }),
          {
            tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
            timeout: 900_000,
          },
        );
      });

      describe("StartAutonomousDatabase", () => {
        test.provider(
          "starts the database as the host's service account",
          (_stack) =>
            Effect.gen(function* () {
              yield* expectProbe(baseUrl, "startAutonomousDatabase");
              expect(yield* waitForDatabaseState("AVAILABLE")).toEqual(
                "AVAILABLE",
              );
              yield* expectProjectGrant(ADB_ADMIN);
            }),
          {
            tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
            timeout: 900_000,
          },
        );
      });

      describe("RestartAutonomousDatabase", () => {
        test.provider(
          "restarts the database as the host's service account",
          (_stack) =>
            Effect.gen(function* () {
              yield* expectProbe(baseUrl, "restartAutonomousDatabase");
              expect(yield* waitForDatabaseState("AVAILABLE")).toEqual(
                "AVAILABLE",
              );
              yield* expectProjectGrant(ADB_ADMIN);
            }),
          {
            tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
            timeout: 900_000,
          },
        );
      });
    });
  },
);
