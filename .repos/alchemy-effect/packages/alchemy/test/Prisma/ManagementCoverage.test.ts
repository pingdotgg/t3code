import * as Prisma from "@/Prisma";
import type { PrismaManagementClient } from "@/Prisma/Client";
import { describe, expect, it } from "alchemy-test";
import {
  managementApiContract,
  productionManagementApiRoutes,
} from "./fixtures/ManagementApiContract.ts";

const canonicalComputeOperations = [
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
] as const satisfies ReadonlyArray<keyof PrismaManagementClient>;

const lifecycleResources = [
  {
    name: "Project",
    resource: Prisma.Project,
    routes: [
      "GET /v1/projects",
      "POST /v1/projects",
      "GET /v1/projects/{id}",
      "PATCH /v1/projects/{id}",
      "DELETE /v1/projects/{id}",
    ],
  },
  {
    name: "Database",
    resource: Prisma.Database,
    routes: [
      "GET /v1/databases",
      "POST /v1/databases",
      "GET /v1/projects/{projectId}/databases",
      "POST /v1/projects/{projectId}/databases",
      "GET /v1/databases/{databaseId}",
      "PATCH /v1/databases/{databaseId}",
      "DELETE /v1/databases/{databaseId}",
    ],
  },
  {
    name: "Connection",
    resource: Prisma.Connection,
    routes: [
      "GET /v1/connections",
      "POST /v1/connections",
      "GET /v1/databases/{databaseId}/connections",
      "POST /v1/databases/{databaseId}/connections",
      "GET /v1/connections/{id}",
      "DELETE /v1/connections/{id}",
    ],
  },
  {
    name: "Branch",
    resource: Prisma.Branch,
    routes: [
      "GET /v1/projects/{projectId}/branches",
      "POST /v1/projects/{projectId}/branches",
      "GET /v1/branches/{branchId}",
      "PATCH /v1/branches/{branchId}",
      "DELETE /v1/branches/{branchId}",
    ],
  },
  {
    name: "Bucket",
    resource: Prisma.Bucket,
    routes: [
      "GET /v1/buckets",
      "POST /v1/buckets",
      "GET /v1/buckets/{bucketId}",
      "DELETE /v1/buckets/{bucketId}",
    ],
  },
  {
    name: "BucketAccessKey",
    resource: Prisma.BucketAccessKey,
    routes: [
      "GET /v1/buckets/{bucketId}/keys",
      "POST /v1/buckets/{bucketId}/keys",
      "DELETE /v1/buckets/{bucketId}/keys/{keyId}",
    ],
  },
  {
    name: "App",
    resource: Prisma.App,
    routes: [
      "GET /v1/apps",
      "POST /v1/apps",
      "GET /v1/apps/{appId}",
      "PATCH /v1/apps/{appId}",
      "DELETE /v1/apps/{appId}",
    ],
  },
  {
    name: "Deployment",
    resource: Prisma.Deployment,
    routes: [
      "GET /v1/apps/{appId}/deployments",
      "POST /v1/apps/{appId}/deployments",
      "GET /v1/deployments/{deploymentId}",
      "DELETE /v1/deployments/{deploymentId}",
      "POST /v1/deployments/{deploymentId}/start",
      "POST /v1/deployments/{deploymentId}/stop",
      "GET /v1/deployments/{deploymentId}/logs",
    ],
  },
  {
    name: "CustomDomain",
    resource: Prisma.CustomDomain,
    routes: [
      "GET /v1/apps/{appId}/domains",
      "POST /v1/apps/{appId}/domains",
      "GET /v1/domains/{domainId}",
      "DELETE /v1/domains/{domainId}",
    ],
  },
  {
    name: "EnvironmentVariable",
    resource: Prisma.EnvironmentVariable,
    routes: [
      "GET /v1/environment-variables",
      "POST /v1/environment-variables",
      "GET /v1/environment-variables/{envVarId}",
      "PATCH /v1/environment-variables/{envVarId}",
      "DELETE /v1/environment-variables/{envVarId}",
    ],
  },
  {
    name: "SourceRepository",
    resource: Prisma.SourceRepository,
    routes: [
      "GET /v1/source-repositories",
      "POST /v1/source-repositories",
      "GET /v1/source-repositories/{id}",
      "DELETE /v1/source-repositories/{id}",
    ],
  },
] as const;

const operationOnlyRoutes = [
  "POST /v1/apps/{appId}/promote",
  "POST /v1/apps/{appId}/rollback",
  "GET /v1/builds/{buildId}/logs",
  "POST /v1/projects/{id}/transfer",
  "GET /v1/databases/{databaseId}/backups",
  "POST /v1/databases/{targetDatabaseId}/restore",
  "GET /v1/databases/{databaseId}/usage",
  "POST /v1/connections/{id}/rotate",
  "POST /v1/domains/{domainId}/retry",
  "GET /v1/me",
  "GET /v1/workspaces",
  "GET /v1/workspaces/{id}",
  "GET /v1/regions",
  "GET /v1/regions/postgres",
  "GET /v1/regions/accelerate",
  "GET /v1/scm-installations",
  "POST /v1/scm-installations/install-intents",
  "GET /v1/scm-installations/{installationId}/repositories",
  "GET /v1/integrations",
  "GET /v1/integrations/{id}",
  "DELETE /v1/integrations/{id}",
  "GET /v1/workspaces/{workspaceId}/integrations",
  "DELETE /v1/workspaces/{workspaceId}/integrations/{clientId}",
] as const;

const expectedManagementApiRoutes = [
  ...lifecycleResources.flatMap((resource) => resource.routes),
  ...operationOnlyRoutes,
].sort();

describe("Prisma Management API coverage", () => {
  it("maps lifecycle route groups to Alchemy resources", () => {
    for (const { name, resource } of lifecycleResources) {
      expect(resource.Type).toBe(`Prisma.${name}`);
    }
  });

  it("accounts for every route in the pinned Management API contract", () => {
    expect(managementApiContract.repository).toBe("prisma/pdp-control-plane");
    expect(managementApiContract.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(managementApiContract.routes).toHaveLength(78);
    expect(managementApiContract.deferredRoutes).toHaveLength(0);
    expect(
      managementApiContract.deferredRoutes.every((route) =>
        managementApiContract.routes.includes(route),
      ),
    ).toBe(true);
    expect(expectedManagementApiRoutes).toHaveLength(78);
    expect(expectedManagementApiRoutes).toEqual(
      [...productionManagementApiRoutes].sort(),
    );
    expect(
      expectedManagementApiRoutes.some((route) => route.includes("/__admin")),
    ).toBe(false);
  });

  it("exports the canonical app and deployment operations", () => {
    for (const operation of canonicalComputeOperations) {
      expect(operation in Prisma).toBe(true);
    }
  });
});
