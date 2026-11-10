import * as PrismaPackage from "@alchemy.run/prisma";
import * as Prisma from "@alchemy.run/prisma";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const publicExports = [
  "CheckViolationError",
  "CliError",
  "ConnectionError",
  "Contract",
  "ContractProvider",
  "ForeignKeyViolationError",
  "Migrate",
  "MigrateProvider",
  "NotNullViolationError",
  "OrmError",
  "QueryError",
  "RollbackError",
  "RuntimeError",
  "UniqueViolationError",
  "UnknownError",
  "Website",
  "wrapPrismaError",

  // Tagged errors each resource's lifecycle fails with.
  "AppConflict",
  "AppInvalidProps",
  "AppOperationFailed",
  "AppUnexpectedResponse",
  "BranchConflict",
  "BranchOperationFailed",
  "BranchUnexpectedResponse",
  "ComputeArchiveInvalidProps",
  "ComputeArchiveOperationFailed",
  "ComputeArchiveOptionsError",
  "ComputeBuildError",
  "ComputeBuildInvalidProps",
  "ComputeConflict",
  "ComputeInvalidProps",
  "ComputeNotReady",
  "ComputeOperationFailed",
  "ComputePackageJsonError",
  "ComputeUnexpectedResponse",
  "ConnectionConflict",
  "ConnectionUnexpectedResponse",
  "CustomDomainConflict",
  "CustomDomainInvalidProps",
  "CustomDomainOperationFailed",
  "CustomDomainUnexpectedResponse",
  "DatabaseConflict",
  "DatabaseInvalidProps",
  "DatabaseOperationFailed",
  "DeploymentConflict",
  "DeploymentInvalidProps",
  "DeploymentOperationFailed",
  "DeploymentUnexpectedResponse",
  "EnvironmentVariableConflict",
  "EnvironmentVariableInvalidProps",
  "InvalidArtifactUploadUrlError",
  "ProjectConflict",
  "ProjectInvalidProps",
  "ProjectUnexpectedResponse",
  "SourceRepositoryConflict",
  "SourceRepositoryInvalidProps",
  "SourceRepositoryOperationFailed",

  "providers",
  "managementApi",
  "Providers",
  "PrismaEnvironment",
  "PrismaAuth",
  "PrismaClient",
  "Project",
  "ProjectProvider",
  "Database",
  "DatabaseProvider",
  "Postgres",
  "Connection",
  "Connect",
  "ConnectBinding",
  "ConnectionProvider",
  "connectEnvKeys",
  "parsePostgresOrigin",
  "Branch",
  "BranchProvider",
  "Bucket",
  "BucketProvider",
  "BucketAccessKey",
  "BucketAccessKeyProvider",
  "BucketProjectMismatchError",
  "BucketError",
  "AmbiguousBucketAccessKeyError",
  "ReadBucket",
  "ReadBucketBinding",
  "readBucketOperations",
  "makeReadBucketClient",
  "WriteBucket",
  "WriteBucketBinding",
  "writeBucketOperations",
  "makeWriteBucketClient",
  "ReadWriteBucket",
  "ReadWriteBucketBinding",
  "makeReadWriteBucketClient",
  "App",
  "AppProvider",
  "Deployment",
  "DeploymentProvider",
  "MAX_DEPLOYMENT_ARTIFACT_BYTES",
  "CustomDomain",
  "CustomDomainProvider",
  "EnvironmentVariable",
  "EnvironmentVariableProvider",
  "SourceRepository",
  "SourceRepositoryProvider",
  "Compute",
  "ComputeProvider",
  "ComputeDevProvider",
  "isCompute",
  "KNOWN_REGION_IDS",
  "REGIONS",
  "PRISMA_AUTH_PROVIDER_NAME",
  "PrismaStoredCredentials",
  "PrismaApiDecodeError",
  "PrismaApiError",
  "PrismaClientLive",
  "PrismaDeploymentFailed",
  "PrismaDeploymentWaitInvalidOptions",
  "PrismaDeploymentWaitTimeout",
  "PrismaLogStreamError",
  "listWorkspaces",
  "getWorkspace",
  "getCurrentPrincipal",
  "listRegions",
  "listPostgresRegions",
  "listAccelerateRegions",
  "listProjects",
  "getProject",
  "createProject",
  "updateProject",
  "deleteProject",
  "transferProject",
  "listDatabases",
  "listProjectDatabases",
  "getDatabase",
  "createDatabase",
  "createProjectDatabase",
  "updateDatabase",
  "deleteDatabase",
  "listBackups",
  "restoreDatabase",
  "getDatabaseUsage",
  "listConnections",
  "listDatabaseConnections",
  "getConnection",
  "createConnection",
  "createDatabaseConnection",
  "deleteConnection",
  "rotateConnection",
  "listBranches",
  "getBranch",
  "createBranch",
  "updateBranch",
  "deleteBranch",
  "listBuckets",
  "getBucket",
  "createBucket",
  "deleteBucket",
  "listBucketKeys",
  "createBucketKey",
  "deleteBucketKey",
  "getCustomDomain",
  "deleteCustomDomain",
  "retryCustomDomain",
  "listApps",
  "getApp",
  "createApp",
  "updateApp",
  "deleteApp",
  "promoteApp",
  "rollbackApp",
  "listAppDomains",
  "createAppDomain",
  "listAppDeployments",
  "createAppDeployment",
  "getDeployment",
  "deleteDeployment",
  "startDeployment",
  "stopDeployment",
  "getDeploymentLogsRequest",
  "getBuildLogsRequest",
  "listEnvironmentVariables",
  "getEnvironmentVariable",
  "createEnvironmentVariable",
  "updateEnvironmentVariable",
  "deleteEnvironmentVariable",
  "listIntegrations",
  "listWorkspaceIntegrations",
  "getIntegration",
  "deleteIntegration",
  "revokeWorkspaceIntegration",
  "listScmInstallations",
  "createScmInstallIntent",
  "listScmInstallationRepositories",
  "listSourceRepositories",
  "getSourceRepository",
  "createSourceRepository",
  "deleteSourceRepository",
  "COMPUTE_MANIFEST_VERSION",
  "createComputeArchive",
  "normalizeEntrypoint",
  "runBuildCommand",
  "runComputeAutoBuild",
  "runComputeStaticBuild",
  "parseDeploymentLogRecord",
  "tailDeploymentLogs",
  "waitForDeploymentStatus",
  "waitForDeploymentUrl",
  "destroyDeployment",
  "destroyApp",
  "destroyProjectApps",
  "toDeploymentUrl",
  "syncComputeEnvironment",
  "readUploadArtifact",
  "uploadArtifact",
  "validateDeploymentArtifactBytes",
  "extractConnectionSecrets",
  "requestBody",
  "isNotFound",
  "isConflict",
  "fromProfile",
] as const;

const publicPrismaDeepImports = [
  "App",
  "AuthProvider",
  "Bootstrap",
  "Branch",
  "Bucket",
  "BucketBinding",
  "BucketAccessKey",
  "BucketTypes",
  "Cli",
  "Client",
  "Compute",
  "ComputeArchive",
  "ComputeBuild",
  "ComputeLifecycle",
  "Connect",
  "Connection",
  "Contributions",
  "CustomDomain",
  "Database",
  "Deployment",
  "EnvironmentVariable",
  "Operations",
  "Postgres",
  "PostgresOrigin",
  "PrismaEnvironment",
  "PrismaLogs",
  "Project",
  "Providers",
  "ReadBucket",
  "ReadWriteBucket",
  "SourceRepository",
  "Types",
  "WriteBucket",
] as const;

// Internal modules live under src/internal/, which the published export map
// blocks; they are not reachable as root deep imports.
const internalPrismaDeepImports = ["Credentials", "PrismaDevDatabase", "Refs"] as const;

const removedPrismaDeepImports = [
  "ComputeApp",
  "ComputeService",
  "ComputeVersion",
  "ComputeVersionObserve",
] as const;

const importPackagePath = (specifier: string) => import(/* @vite-ignore */ specifier);

describe("Prisma public surface", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it("exports the user-facing resources, providers, and operations", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(Prisma).sort()).toEqual(expected);
    expect(Prisma.KNOWN_REGION_IDS).toContain("us-east-1");
    expect(Prisma.REGIONS[0]).toEqual({
      id: Prisma.KNOWN_REGION_IDS[0],
      displayName: Prisma.KNOWN_REGION_IDS[0],
    });
  });

  it("exports the same surface through the @alchemy.run/prisma package path", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(PrismaPackage).sort()).toEqual(expected);
  });

  it(
    "supports deep Prisma package path imports",
    async () => {
      for (const moduleName of publicPrismaDeepImports) {
        const module = await importPackagePath(`@alchemy.run/prisma/${moduleName}`);
        expect(Object.keys(module as object).length).toBeGreaterThan(0);
      }

      const [compute, operations, client, archive, types, postgres] = await Promise.all([
        import("@alchemy.run/prisma/Compute"),
        import("@alchemy.run/prisma/Operations"),
        import("@alchemy.run/prisma/Client"),
        import("@alchemy.run/prisma/ComputeArchive"),
        import("@alchemy.run/prisma/Types"),
        import("@alchemy.run/prisma/Postgres"),
      ]);

      expect(compute.Compute.Type).toBe("Prisma.Compute");
      expect(typeof operations.listProjects).toBe("function");
      expect(typeof client.PrismaApiError).toBe("function");
      expect(archive.COMPUTE_MANIFEST_VERSION).toBe("1");
      expect(types.KNOWN_REGION_IDS).toContain("us-east-1");
      expect(postgres.Postgres.Type).toBe("Prisma.Database");
      expect(Prisma.Postgres).toBe(Prisma.Database);
    },
    { tags: ["provider:prisma:database"] },
  );

  it("does not expose removed Compute deep imports", async () => {
    for (const moduleName of removedPrismaDeepImports) {
      await expect(importPackagePath(`@alchemy.run/prisma/${moduleName}`)).rejects.toThrow();
    }
  });

  it("does not expose internal Prisma deep imports", async () => {
    for (const moduleName of internalPrismaDeepImports) {
      await expect(importPackagePath(`@alchemy.run/prisma/${moduleName}`)).rejects.toThrow();
    }
  });

  it.effect("keeps Prisma root modules intentionally classified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prismaSourceRoot = path.resolve(import.meta.dirname, "../../../prisma/src");
      const files = (yield* fs.readDirectory(prismaSourceRoot))
        .filter((file) => file.endsWith(".ts"))
        .sort();

      expect(files).toEqual(
        ["index.ts", ...publicPrismaDeepImports.map((moduleName) => `${moduleName}.ts`)].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks internal Prisma deep imports in the package export map", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageJsonPath = path.resolve(import.meta.dirname, "../../../prisma/package.json");
      const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath));

      expect(packageJson.publishConfig.exports["./internal/*"]).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pins Prisma package export map entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageJsonPath = path.resolve(import.meta.dirname, "../../../prisma/package.json");
      const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath));

      expect(packageJson.exports["."]).toBe("./src/index.ts");
      expect(packageJson.exports["./ORM"]).toBe("./src/ORM/index.ts");
      // Deep Prisma modules use the package-wide source export wildcard.
      expect(packageJson.exports["./*"]).toBe("./src/*.ts");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
