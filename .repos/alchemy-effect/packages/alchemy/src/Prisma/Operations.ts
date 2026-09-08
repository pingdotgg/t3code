import * as Effect from "effect/Effect";
import { PrismaClient, type PrismaManagementClient } from "./Client.ts";
import type {
  AppCreateInput,
  AppDeploymentTarget,
  AppUpdateInput,
  BranchCreateInput,
  BranchUpdateInput,
  BucketCreateInput,
  BucketKeyCreateInput,
  BuildLogsQuery,
  DatabaseConnectionCreateInput,
  DeploymentCreateInput,
  DeploymentLogsQuery,
  ConnectionCreateInput,
  CustomDomainCreateInput,
  DatabaseCreateInput,
  DatabaseUpdateInput,
  EnvironmentVariableCreateInput,
  EnvironmentVariableUpdateInput,
  PrismaBranchIdFilter,
  ProjectCreateInput,
  ProjectDatabaseCreateInput,
  ProjectTransferInput,
  ProjectUpdateInput,
  RestoreDatabaseInput,
  ScmInstallIntentCreateInput,
  SourceRepositoryCreateInput,
} from "./Types.ts";

const withClient = <A, E, R>(
  f: (client: PrismaManagementClient) => Effect.Effect<A, E, R>,
) => Effect.flatMap(PrismaClient, f);

export const listWorkspaces = (query?: {
  cursor?: string | null;
  limit?: number;
}) => withClient((client) => client.listWorkspaces(query));
export const getWorkspace = (id: string) =>
  withClient((client) => client.getWorkspace(id));
export const getCurrentPrincipal = () =>
  withClient((client) => client.getCurrentPrincipal());

export const listRegions = (query?: { product?: "postgres" | "accelerate" }) =>
  withClient((client) => client.listRegions(query));
export const listPostgresRegions = () =>
  withClient((client) => client.listPostgresRegions());
export const listAccelerateRegions = () =>
  withClient((client) => client.listAccelerateRegions());

export const listProjects = (query?: {
  cursor?: string | null;
  limit?: number;
}) => withClient((client) => client.listProjects(query));
export const getProject = (id: string) =>
  withClient((client) => client.getProject(id));
export const createProject = (input: ProjectCreateInput) =>
  withClient((client) => client.createProject(input));
export const updateProject = (id: string, input: ProjectUpdateInput) =>
  withClient((client) => client.updateProject(id, input));
export const deleteProject = (id: string) =>
  withClient((client) => client.deleteProject(id));
export const transferProject = (id: string, input: ProjectTransferInput) =>
  withClient((client) => client.transferProject(id, input));

export const listDatabases = (query?: {
  cursor?: string | null;
  limit?: number;
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}) => withClient((client) => client.listDatabases(query));
export const listProjectDatabases = (
  projectId: string,
  query?: { cursor?: string | null; limit?: number },
) => withClient((client) => client.listProjectDatabases(projectId, query));
export const getDatabase = (id: string) =>
  withClient((client) => client.getDatabase(id));
export const createDatabase = (input: DatabaseCreateInput) =>
  withClient((client) => client.createDatabase(input));
export const createProjectDatabase = (
  projectId: string,
  input: ProjectDatabaseCreateInput,
) => withClient((client) => client.createProjectDatabase(projectId, input));
export const updateDatabase = (id: string, input: DatabaseUpdateInput) =>
  withClient((client) => client.updateDatabase(id, input));
export const deleteDatabase = (id: string) =>
  withClient((client) => client.deleteDatabase(id));
export const listBackups = (databaseId: string, query?: { limit?: number }) =>
  withClient((client) => client.listBackups(databaseId, query));
export const restoreDatabase = (
  targetDatabaseId: string,
  input: RestoreDatabaseInput,
) => withClient((client) => client.restoreDatabase(targetDatabaseId, input));
export const getDatabaseUsage = (
  databaseId: string,
  query?: { startDate?: string; endDate?: string },
) => withClient((client) => client.getDatabaseUsage(databaseId, query));

export const listConnections = (query?: {
  cursor?: string | null;
  limit?: number;
  databaseId?: string;
}) => withClient((client) => client.listConnections(query));
export const listDatabaseConnections = (
  databaseId: string,
  query?: { cursor?: string | null; limit?: number },
) => withClient((client) => client.listDatabaseConnections(databaseId, query));
export const getConnection = (id: string) =>
  withClient((client) => client.getConnection(id));
export const createConnection = (input: ConnectionCreateInput) =>
  withClient((client) => client.createConnection(input));
export const createDatabaseConnection = (
  databaseId: string,
  input: DatabaseConnectionCreateInput,
) => withClient((client) => client.createDatabaseConnection(databaseId, input));
export const deleteConnection = (id: string) =>
  withClient((client) => client.deleteConnection(id));
export const rotateConnection = (id: string) =>
  withClient((client) => client.rotateConnection(id));

export const listBranches = (
  projectId: string,
  query?: {
    cursor?: string | null;
    limit?: number;
    gitName?: string;
    gitNameContains?: string;
  },
) => withClient((client) => client.listBranches(projectId, query));
export const getBranch = (id: string) =>
  withClient((client) => client.getBranch(id));
export const createBranch = (projectId: string, input: BranchCreateInput) =>
  withClient((client) => client.createBranch(projectId, input));
export const updateBranch = (id: string, input: BranchUpdateInput) =>
  withClient((client) => client.updateBranch(id, input));
export const deleteBranch = (id: string) =>
  withClient((client) => client.deleteBranch(id));

export const listBuckets = (query?: {
  cursor?: string | null;
  limit?: number;
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}) => withClient((client) => client.listBuckets(query));
export const getBucket = (id: string) =>
  withClient((client) => client.getBucket(id));
export const createBucket = (input: BucketCreateInput) =>
  withClient((client) => client.createBucket(input));
export const deleteBucket = (id: string) =>
  withClient((client) => client.deleteBucket(id));
export const listBucketKeys = (
  bucketId: string,
  query?: { cursor?: string | null; limit?: number },
) => withClient((client) => client.listBucketKeys(bucketId, query));
export const createBucketKey = (
  bucketId: string,
  input: BucketKeyCreateInput,
) => withClient((client) => client.createBucketKey(bucketId, input));
export const deleteBucketKey = (bucketId: string, keyId: string) =>
  withClient((client) => client.deleteBucketKey(bucketId, keyId));

export const getCustomDomain = (id: string) =>
  withClient((client) => client.getCustomDomain(id));
export const deleteCustomDomain = (id: string) =>
  withClient((client) => client.deleteCustomDomain(id));
export const retryCustomDomain = (id: string) =>
  withClient((client) => client.retryCustomDomain(id));

export const listApps = (query?: {
  cursor?: string | null;
  limit?: number;
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}) => withClient((client) => client.listApps(query));
export const getApp = (id: string) => withClient((client) => client.getApp(id));
export const createApp = (input: AppCreateInput) =>
  withClient((client) => client.createApp(input));
export const updateApp = (id: string, input: AppUpdateInput) =>
  withClient((client) => client.updateApp(id, input));
export const deleteApp = (id: string) =>
  withClient((client) => client.deleteApp(id));
export const promoteApp = (id: string, target: AppDeploymentTarget) =>
  withClient((client) => client.promoteApp(id, target));
export const rollbackApp = (id: string, target: AppDeploymentTarget) =>
  withClient((client) => client.rollbackApp(id, target));
export const listAppDomains = (appId: string) =>
  withClient((client) => client.listAppDomains(appId));
export const createAppDomain = (
  appId: string,
  input: CustomDomainCreateInput,
) => withClient((client) => client.createAppDomain(appId, input));
export const listAppDeployments = (
  appId: string,
  query?: { cursor?: string | null; limit?: number },
) => withClient((client) => client.listAppDeployments(appId, query));
export const createAppDeployment = (
  appId: string,
  input?: DeploymentCreateInput,
) => withClient((client) => client.createAppDeployment(appId, input));
export const getDeployment = (id: string) =>
  withClient((client) => client.getDeployment(id));
export const deleteDeployment = (id: string) =>
  withClient((client) => client.deleteDeployment(id));
export const startDeployment = (id: string) =>
  withClient((client) => client.startDeployment(id));
export const stopDeployment = (id: string) =>
  withClient((client) => client.stopDeployment(id));
export const getDeploymentLogsRequest = (
  id: string,
  query?: DeploymentLogsQuery,
) => withClient((client) => client.getDeploymentLogsRequest(id, query));
export const getBuildLogsRequest = (buildId: string, query?: BuildLogsQuery) =>
  withClient((client) => client.getBuildLogsRequest(buildId, query));

export const listEnvironmentVariables = (query?: {
  cursor?: string | null;
  limit?: number;
  projectId?: string;
  class?: "production" | "preview";
  key?: string;
  branchId?: string;
}) => withClient((client) => client.listEnvironmentVariables(query));
export const getEnvironmentVariable = (id: string) =>
  withClient((client) => client.getEnvironmentVariable(id));
export const createEnvironmentVariable = (
  input: EnvironmentVariableCreateInput,
) => withClient((client) => client.createEnvironmentVariable(input));
export const updateEnvironmentVariable = (
  id: string,
  input: EnvironmentVariableUpdateInput,
) => withClient((client) => client.updateEnvironmentVariable(id, input));
export const deleteEnvironmentVariable = (id: string) =>
  withClient((client) => client.deleteEnvironmentVariable(id));

export const listIntegrations = (query: {
  workspaceId: string;
  cursor?: string | null;
  limit?: number;
}) => withClient((client) => client.listIntegrations(query));
export const listWorkspaceIntegrations = (
  workspaceId: string,
  query?: { cursor?: string | null; limit?: number },
) =>
  withClient((client) => client.listWorkspaceIntegrations(workspaceId, query));
export const getIntegration = (id: string) =>
  withClient((client) => client.getIntegration(id));
export const deleteIntegration = (id: string) =>
  withClient((client) => client.deleteIntegration(id));
export const revokeWorkspaceIntegration = (
  workspaceId: string,
  clientId: string,
) =>
  withClient((client) =>
    client.revokeWorkspaceIntegration(workspaceId, clientId),
  );

export const listScmInstallations = (query: {
  workspaceId: string;
  cursor?: string | null;
  limit?: number;
}) => withClient((client) => client.listScmInstallations(query));
export const createScmInstallIntent = (input: ScmInstallIntentCreateInput) =>
  withClient((client) => client.createScmInstallIntent(input));
export const listScmInstallationRepositories = (
  installationId: string,
  query?: { cursor?: string | null; limit?: number },
) =>
  withClient((client) =>
    client.listScmInstallationRepositories(installationId, query),
  );

export const listSourceRepositories = (query: {
  projectId: string;
  cursor?: string | null;
  limit?: number;
}) => withClient((client) => client.listSourceRepositories(query));
export const getSourceRepository = (id: string) =>
  withClient((client) => client.getSourceRepository(id));
export const createSourceRepository = (input: SourceRepositoryCreateInput) =>
  withClient((client) => client.createSourceRepository(input));
export const deleteSourceRepository = (id: string) =>
  withClient((client) => client.deleteSourceRepository(id));
