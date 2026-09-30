import { PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import * as Prisma from "@/Prisma/Operations";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Credentials } from "@/Prisma/Credentials";

type AssertNever<T extends never> = T;
type ClientOperation = Exclude<
  keyof PrismaManagementClient,
  "request" | "paginate"
>;
export type PrismaOperationCoverage = [
  AssertNever<Exclude<ClientOperation, keyof typeof Prisma>>,
  AssertNever<Exclude<keyof typeof Prisma, ClientOperation>>,
];

const expectedOperationHelpers = [
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
];

describe("Prisma operation helpers", () => {
  it.effect("delegate every public operation helper to PrismaClient", () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = new Proxy(
      {},
      {
        get:
          (_target, prop) =>
          (...args: unknown[]) =>
            Effect.sync(() => {
              calls.push([String(prop), args]);
              return { ok: true };
            }),
      },
    ) as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      yield* Prisma.listWorkspaces({ limit: 1 });
      yield* Prisma.getWorkspace("workspace-1");
      yield* Prisma.getCurrentPrincipal();
      yield* Prisma.listRegions({ product: "postgres" });
      yield* Prisma.listPostgresRegions();
      yield* Prisma.listAccelerateRegions();

      yield* Prisma.listProjects({ limit: 1 });
      yield* Prisma.getProject("project-1");
      yield* Prisma.createProject({ name: "app" });
      yield* Prisma.updateProject("project-1", { name: "renamed" });
      yield* Prisma.deleteProject("project-1");
      yield* Prisma.transferProject("project-1", {
        recipientAccessToken: "recipient-token",
      });

      yield* Prisma.listDatabases({ projectId: "project-1" });
      yield* Prisma.listProjectDatabases("project-1", { limit: 1 });
      yield* Prisma.getDatabase("database-1");
      yield* Prisma.createDatabase({ projectId: "project-1" });
      yield* Prisma.createProjectDatabase("project-1", {
        region: "us-east-1",
        source: {
          type: "backup",
          databaseId: "database-source",
          backupId: "backup-1",
        },
      });
      yield* Prisma.updateDatabase("database-1", { name: "renamed" });
      yield* Prisma.deleteDatabase("database-1");
      yield* Prisma.listBackups("database-1", { limit: 1 });
      yield* Prisma.restoreDatabase("database-1", {
        source: {
          type: "backup",
          databaseId: "source-database",
          backupId: "backup-1",
        },
      });
      yield* Prisma.getDatabaseUsage("database-1", {
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      });

      yield* Prisma.listConnections({ databaseId: "database-1" });
      yield* Prisma.listDatabaseConnections("database-1", { limit: 1 });
      yield* Prisma.getConnection("connection-1");
      yield* Prisma.createConnection({
        databaseId: "database-1",
        name: "api",
      });
      yield* Prisma.createDatabaseConnection("database-1", { name: "api" });
      yield* Prisma.deleteConnection("connection-1");
      yield* Prisma.rotateConnection("connection-1");

      yield* Prisma.listBranches("project-1", { gitName: "main" });
      yield* Prisma.getBranch("branch-1");
      yield* Prisma.createBranch("project-1", { gitName: "main" });
      yield* Prisma.updateBranch("branch-1", { isDefault: true });
      yield* Prisma.deleteBranch("branch-1");

      yield* Prisma.listBuckets({ projectId: "project-1" });
      yield* Prisma.getBucket("bucket-1");
      yield* Prisma.createBucket({ projectId: "project-1", name: "uploads" });
      yield* Prisma.deleteBucket("bucket-1");
      yield* Prisma.listBucketKeys("bucket-1", { limit: 1 });
      yield* Prisma.createBucketKey("bucket-1", { role: "read_write" });
      yield* Prisma.deleteBucketKey("bucket-1", "key-1");

      yield* Prisma.getCustomDomain("domain-1");
      yield* Prisma.deleteCustomDomain("domain-1");
      yield* Prisma.retryCustomDomain("domain-1");

      yield* Prisma.listApps({ projectId: "project-1" });
      yield* Prisma.getApp("app-1");
      yield* Prisma.createApp({ projectId: "project-1", displayName: "web" });
      yield* Prisma.updateApp("app-1", { displayName: "renamed" });
      yield* Prisma.deleteApp("app-1");
      yield* Prisma.promoteApp("app-1", { deploymentId: "deployment-1" });
      yield* Prisma.rollbackApp("app-1", { deploymentId: "deployment-1" });
      yield* Prisma.listAppDomains("app-1");
      yield* Prisma.createAppDomain("app-1", { hostname: "web.example.com" });
      yield* Prisma.listAppDeployments("app-1", { limit: 1 });
      yield* Prisma.createAppDeployment("app-1", { skipCodeUpload: true });
      yield* Prisma.getDeployment("deployment-1");
      yield* Prisma.deleteDeployment("deployment-1");
      yield* Prisma.startDeployment("deployment-1");
      yield* Prisma.stopDeployment("deployment-1");
      yield* Prisma.getDeploymentLogsRequest("deployment-1", { tail: 10 });
      yield* Prisma.getBuildLogsRequest("build-1", { follow: true });

      yield* Prisma.listEnvironmentVariables({ projectId: "project-1" });
      yield* Prisma.getEnvironmentVariable("env-1");
      yield* Prisma.createEnvironmentVariable({
        projectId: "project-1",
        class: "production",
        key: "TOKEN",
        value: "secret",
      });
      yield* Prisma.updateEnvironmentVariable("env-1", { value: "next" });
      yield* Prisma.deleteEnvironmentVariable("env-1");

      yield* Prisma.listIntegrations({ workspaceId: "workspace-1" });
      yield* Prisma.listWorkspaceIntegrations("workspace-1", { limit: 1 });
      yield* Prisma.getIntegration("integration-1");
      yield* Prisma.deleteIntegration("integration-1");
      yield* Prisma.revokeWorkspaceIntegration("workspace-1", "client-1");

      yield* Prisma.listScmInstallations({ workspaceId: "workspace-1" });
      yield* Prisma.createScmInstallIntent({
        provider: "github",
        workspaceId: "workspace-1",
      });
      yield* Prisma.listScmInstallationRepositories("scminstall-1", {
        limit: 10,
      });

      yield* Prisma.listSourceRepositories({ projectId: "project-1" });
      yield* Prisma.getSourceRepository("repo-1");
      yield* Prisma.createSourceRepository({
        projectId: "project-1",
        provider: "github",
        providerRepositoryId: 123,
      });
      yield* Prisma.deleteSourceRepository("repo-1");

      expect(Object.keys(Prisma).sort()).toEqual(
        [...expectedOperationHelpers].sort(),
      );
      // The log-request builders resolve the distilled Credentials service
      // directly instead of delegating to the client, so they never appear in
      // `calls`.
      expect(calls.map(([name]) => name)).toEqual(
        expectedOperationHelpers.filter(
          (name) =>
            name !== "getDeploymentLogsRequest" &&
            name !== "getBuildLogsRequest",
        ),
      );
    }).pipe(
      Effect.provideService(PrismaClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          apiToken: Redacted.make("test-token"),
          apiBaseUrl: "https://api.prisma.test",
        }),
      ),
    );
  });
});
