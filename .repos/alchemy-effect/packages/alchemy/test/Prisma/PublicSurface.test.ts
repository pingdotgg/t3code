import * as Prisma from "@/Prisma";
import * as PrismaPackage from "alchemy/Prisma";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const publicExports = [
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
  "Branch",
  "Bucket",
  "BucketBinding",
  "BucketAccessKey",
  "BucketTypes",
  "Client",
  "Compute",
  "ComputeArchive",
  "ComputeBuild",
  "ComputeLifecycle",
  "Connect",
  "Connection",
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

const internalPrismaDeepImports = [
  "Internal/DeploymentActions",
  "Internal/DeploymentObserve",
  "PrismaDevDatabase",
  "Refs",
] as const;

const internalPrismaRootFiles = ["PrismaDevDatabase", "Refs"] as const;

const removedPrismaDeepImports = [
  "ComputeApp",
  "ComputeService",
  "ComputeVersion",
  "ComputeVersionObserve",
] as const;

const importPackagePath = (specifier: string) =>
  import(/* @vite-ignore */ specifier);

describe("Prisma public surface", () => {
  it("exports the user-facing resources, providers, and operations", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(Prisma).sort()).toEqual(expected);
    expect(Prisma.KNOWN_REGION_IDS).toContain("us-east-1");
    expect(Prisma.REGIONS[0]).toEqual({
      id: Prisma.KNOWN_REGION_IDS[0],
      displayName: Prisma.KNOWN_REGION_IDS[0],
    });
  });

  it("exports the same surface through the alchemy/Prisma package path", () => {
    const expected = [...publicExports].sort();

    expect(Object.keys(PrismaPackage).sort()).toEqual(expected);
  });

  it("supports deep Prisma package path imports", async () => {
    for (const moduleName of publicPrismaDeepImports) {
      const module = await importPackagePath(`alchemy/Prisma/${moduleName}`);
      expect(Object.keys(module as object).length).toBeGreaterThan(0);
    }

    const [compute, operations, client, archive, types, postgres] =
      await Promise.all([
        import("alchemy/Prisma/Compute"),
        import("alchemy/Prisma/Operations"),
        import("alchemy/Prisma/Client"),
        import("alchemy/Prisma/ComputeArchive"),
        import("alchemy/Prisma/Types"),
        import("alchemy/Prisma/Postgres"),
      ]);

    expect(compute.Compute.Type).toBe("Prisma.Compute");
    expect(typeof operations.listProjects).toBe("function");
    expect(typeof client.PrismaApiError).toBe("function");
    expect(archive.COMPUTE_MANIFEST_VERSION).toBe("1");
    expect(types.KNOWN_REGION_IDS).toContain("us-east-1");
    expect(postgres.Postgres.Type).toBe("Prisma.Database");
    expect(Prisma.Postgres).toBe(Prisma.Database);
  });

  it("does not expose removed Compute deep imports", async () => {
    for (const moduleName of removedPrismaDeepImports) {
      await expect(
        importPackagePath(`alchemy/Prisma/${moduleName}`),
      ).rejects.toThrow();
    }
  });

  it("does not expose internal Prisma deep imports", async () => {
    for (const moduleName of internalPrismaDeepImports) {
      await expect(
        importPackagePath(`alchemy/Prisma/${moduleName}`),
      ).rejects.toThrow();
    }
  });

  it.effect("keeps Prisma root modules intentionally classified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prismaSourceRoot = path.resolve(
        import.meta.dirname,
        "../../src/Prisma",
      );
      const files = (yield* fs.readDirectory(prismaSourceRoot))
        .filter((file) => file.endsWith(".ts"))
        .sort();

      expect(files).toEqual(
        [
          "index.ts",
          ...publicPrismaDeepImports.map((moduleName) => `${moduleName}.ts`),
          ...internalPrismaRootFiles.map((moduleName) => `${moduleName}.ts`),
        ].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "blocks internal Prisma deep imports in the package export map",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const packageJsonPath = path.resolve(
          import.meta.dirname,
          "../../package.json",
        );
        const packageJson = JSON.parse(
          yield* fs.readFileString(packageJsonPath),
        );

        for (const moduleName of internalPrismaDeepImports) {
          const exportPath = moduleName.startsWith("Internal/")
            ? "./Prisma/Internal/*"
            : `./Prisma/${moduleName}`;
          expect(packageJson.exports[exportPath]).toBeNull();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pins Prisma package export map entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageJsonPath = path.resolve(
        import.meta.dirname,
        "../../package.json",
      );
      const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath));

      expect(packageJson.exports["./Prisma"]).toEqual({
        types: "./lib/Prisma/index.d.ts",
        bun: "./src/Prisma/index.ts",
        worker: "./src/Prisma/index.ts",
        import: "./lib/Prisma/index.js",
      });
      expect(packageJson.exports["./Prisma/*"]).toEqual({
        types: "./lib/Prisma/*.d.ts",
        bun: "./src/Prisma/*.ts",
        worker: "./src/Prisma/*.ts",
        import: "./lib/Prisma/*.js",
      });
      for (const moduleName of removedPrismaDeepImports) {
        expect(packageJson.exports[`./Prisma/${moduleName}`]).toBeNull();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
