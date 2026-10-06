import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const location = "us-central1";

const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alchemy-test";

export const OracleNet = GCP.OracleDatabase.OdbNetwork("OracleNet", {
  location,
  network: "default",
  labels: { env: "test" },
});

export const Client = Effect.gen(function* () {
  const network = yield* OracleNet;
  return yield* GCP.OracleDatabase.OdbNetworksOdbSubnet("Client", {
    odbNetwork: network.name,
    location,
    cidrRange: "10.250.0.0/27",
    purpose: "CLIENT_SUBNET",
    labels: { env: "test" },
  });
});

export const Backup = Effect.gen(function* () {
  const network = yield* OracleNet;
  return yield* GCP.OracleDatabase.OdbNetworksOdbSubnet("Backup", {
    odbNetwork: network.name,
    location,
    cidrRange: "10.250.0.32/28",
    purpose: "BACKUP_SUBNET",
    labels: { env: "test" },
  });
});

export const AppDb = GCP.OracleDatabase.AutonomousDatabase("AppDb", {
  location,
  network: "default",
  cidr: "10.10.0.0/24",
  adminPassword: "AlchemyTest1!",
  displayName: "alchemy-bind-adb",
  labels: { env: "test" },
  licenseType: "LICENSE_INCLUDED",
  dbWorkload: "OLTP",
  cpuCoreCount: 2,
  dataStorageSizeGb: 20,
});

export const Exa = GCP.OracleDatabase.CloudExadataInfrastructure("Exa", {
  displayName: "alchemy-bind-exa",
  shape: "Exadata.X9M",
  computeCount: 2,
  storageCount: 3,
});

export const Vms = Effect.gen(function* () {
  const infra = yield* Exa;
  return yield* GCP.OracleDatabase.CloudVmCluster("Vms", {
    location,
    exadataInfrastructure: infra.name,
    network: "default",
    cidr: "10.12.0.0/24",
    backupSubnetCidr: "10.12.1.0/24",
    licenseType: "LICENSE_INCLUDED",
    cpuCoreCount: 4,
    giVersion: "19.0.0.0",
    hostnamePrefix: "exa",
    sshPublicKeys: [SSH_KEY],
    labels: { env: "test" },
  });
});

export const BaseDb = Effect.gen(function* () {
  const subnet = yield* Client;
  return yield* GCP.OracleDatabase.DbSystem("BaseDb", {
    location,
    displayName: "alchemy-bind-dbsystem",
    odbSubnet: subnet.name,
    shape: "VM.Standard.E4.Flex",
    sshPublicKeys: [SSH_KEY],
    computeCount: 2,
    initialDataStorageSizeGb: 256,
    licenseModel: "LICENSE_INCLUDED",
    databaseEdition: "ENTERPRISE_EDITION",
    labels: { env: "test" },
  });
});

export const Vault = GCP.OracleDatabase.ExascaleDbStorageVault("Vault", {
  displayName: "alchemyvault",
  totalSizeGbs: 300,
});

export const ExaVm = Effect.gen(function* () {
  const vault = yield* Vault;
  const subnet = yield* Client;
  const backup = yield* Backup;
  return yield* GCP.OracleDatabase.ExadbVmCluster("ExaVm", {
    location,
    displayName: "alchemyexavm",
    odbSubnet: subnet.name,
    backupOdbSubnet: backup.name,
    gridImageId: "19.0.0.0",
    hostnamePrefix: "exavm",
    sshPublicKeys: [SSH_KEY],
    exascaleDbStorageVault: vault.name,
    enabledEcpuCountPerNode: 8,
    nodeCount: 2,
    properties: {
      vmFileSystemStorage: { sizeInGbsPerNode: 180 },
      shapeAttribute: "SMART_STORAGE",
    },
  });
});

export const Src = GCP.OracleDatabase.GoldengateConnection("Src", {
  location,
  connectionType: "GENERIC",
  displayName: "alchemy-gg-src",
  properties: {
    genericConnectionProperties: {
      host: "db.example.com",
      technologyType: "GENERIC",
    },
  },
});

export const Replicat = Effect.gen(function* () {
  const network = yield* OracleNet;
  const subnet = yield* Client;
  return yield* GCP.OracleDatabase.GoldengateDeployment("Replicat", {
    location,
    odbNetwork: network.name,
    odbSubnet: subnet.name,
    displayName: "alchemy-gg",
    deploymentType: "DATABASE_ORACLE",
    oggData: {
      adminUsername: "oggadmin",
      deployment: "oggdeploy",
      adminPassword: "AlchemyTest1!",
    },
    labels: { env: "test" },
  });
});

export const Assign = Effect.gen(function* () {
  const connection = yield* Src;
  const deployment = yield* Replicat;
  return yield* GCP.OracleDatabase.GoldengateConnectionAssignment("Assign", {
    location,
    displayName: "alchemy-gg-assign",
    goldengateConnection: connection.name,
    goldengateDeployment: deployment.name,
    labels: { env: "test" },
  });
});

/** Wallet password the `generateWallet` probe uses. */
export const WALLET_PASSWORD = "AlchemyTest1!";

/**
 * Effect-native Cloud Run service exercising every Oracle Database@Google
 * Cloud binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts} (only with GCP_TEST_ORACLE).
 */
export default class OracleBindingsHost extends GCP.Function<OracleBindingsHost>()(
  "OracleBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const db = yield* AppDb;
    const getNetwork = yield* GCP.OracleDatabase.GetOdbNetwork(
      yield* OracleNet,
    );
    const getSubnet = yield* GCP.OracleDatabase.GetOdbNetworksOdbSubnet(
      yield* Client,
    );
    const getDb = yield* GCP.OracleDatabase.GetAutonomousDatabase(db);
    const generateWallet = yield* GCP.OracleDatabase.GenerateWallet(db);
    const start = yield* GCP.OracleDatabase.StartAutonomousDatabase(db);
    const stop = yield* GCP.OracleDatabase.StopAutonomousDatabase(db);
    const restart = yield* GCP.OracleDatabase.RestartAutonomousDatabase(db);
    const getInfra = yield* GCP.OracleDatabase.GetCloudExadataInfrastructure(
      yield* Exa,
    );
    const getVmCluster = yield* GCP.OracleDatabase.GetCloudVmCluster(
      yield* Vms,
    );
    const getDbSystem = yield* GCP.OracleDatabase.GetDbSystem(yield* BaseDb);
    const getVault = yield* GCP.OracleDatabase.GetExascaleDbStorageVault(
      yield* Vault,
    );
    const getExadb = yield* GCP.OracleDatabase.GetExadbVmCluster(yield* ExaVm);
    const getConnection = yield* GCP.OracleDatabase.GetGoldengateConnection(
      yield* Src,
    );
    const getDeployment = yield* GCP.OracleDatabase.GetGoldengateDeployment(
      yield* Replicat,
    );
    const getAssignment =
      yield* GCP.OracleDatabase.GetGoldengateConnectionAssignment(
        yield* Assign,
      );

    return {
      fetch: serveProbes({
        getOdbNetwork: getNetwork(),
        getOdbNetworksOdbSubnet: getSubnet(),
        getAutonomousDatabase: getDb(),
        generateWallet: generateWallet({
          body: { password: WALLET_PASSWORD, type: "SINGLE" },
        }),
        stopAutonomousDatabase: stop(),
        startAutonomousDatabase: start(),
        restartAutonomousDatabase: restart(),
        getCloudExadataInfrastructure: getInfra(),
        getCloudVmCluster: getVmCluster(),
        getDbSystem: getDbSystem(),
        getExascaleDbStorageVault: getVault(),
        getExadbVmCluster: getExadb(),
        getGoldengateConnection: getConnection(),
        getGoldengateDeployment: getDeployment(),
        getGoldengateConnectionAssignment: getAssignment(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.OracleDatabase.GetOdbNetworkHttp),
    Effect.provide(GCP.OracleDatabase.GetOdbNetworksOdbSubnetHttp),
    Effect.provide(GCP.OracleDatabase.GetAutonomousDatabaseHttp),
    Effect.provide(GCP.OracleDatabase.GenerateWalletHttp),
    Effect.provide(GCP.OracleDatabase.StartAutonomousDatabaseHttp),
    Effect.provide(GCP.OracleDatabase.StopAutonomousDatabaseHttp),
    Effect.provide(GCP.OracleDatabase.RestartAutonomousDatabaseHttp),
    Effect.provide(GCP.OracleDatabase.GetCloudExadataInfrastructureHttp),
    Effect.provide(GCP.OracleDatabase.GetCloudVmClusterHttp),
    Effect.provide(GCP.OracleDatabase.GetDbSystemHttp),
    Effect.provide(GCP.OracleDatabase.GetExascaleDbStorageVaultHttp),
    Effect.provide(GCP.OracleDatabase.GetExadbVmClusterHttp),
    Effect.provide(GCP.OracleDatabase.GetGoldengateConnectionHttp),
    Effect.provide(GCP.OracleDatabase.GetGoldengateDeploymentHttp),
    Effect.provide(GCP.OracleDatabase.GetGoldengateConnectionAssignmentHttp),
  ),
) {}
