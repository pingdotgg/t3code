import type * as Redacted from "effect/Redacted";

export const KNOWN_REGION_IDS = [
  "us-east-1",
  "us-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
] as const;

export const REGIONS = KNOWN_REGION_IDS.map((id) => ({
  id,
  displayName: id,
}));

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface DataResponse<T> {
  data: T;
}

export interface ResourceRef {
  id: string;
  url: string;
  name: string;
}

export type PrismaRegionId = (typeof KNOWN_REGION_IDS)[number];

export type PrismaDatabaseRegionId = PrismaRegionId | "inherit";

export type PrismaBranchIdFilter = "unassigned" | (string & {});

export interface Workspace {
  id: string;
  type: "workspace";
  url: string;
  name: string;
  createdAt: string;
}

export interface CurrentPrincipal {
  user: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  workspace: {
    id: string;
    name: string;
  } | null;
  credential: {
    type: "oauth" | "service_token" | "management_token";
    id: string | null;
    name: string | null;
  };
}

export interface Region {
  id: string;
  type: "region";
  name: string;
  product: "postgres" | "accelerate";
  status?: "available" | "unavailable";
}

export interface PostgresRegion {
  id: string;
  type: "region";
  name: string;
  status: "available" | "unavailable";
}

export interface AccelerateRegion {
  id: string;
  type: "region";
  name: string;
}

export interface Project {
  id: string;
  type: "project";
  url: string;
  name: string;
  createdAt: string;
  defaultRegion: string | null;
  workspace: ResourceRef;
}

export interface ProjectCreateInput {
  name?: string;
  createDatabase?: boolean;
  region?: PrismaRegionId;
}

export interface ProjectUpdateInput {
  name?: string;
  settings?: Record<string, unknown>;
}

export interface ProjectTransferInput {
  recipientAccessToken: string;
}

export type DatabaseStatus =
  | "failure"
  | "provisioning"
  | "ready"
  | "recovering";

export interface EndpointDetail {
  host: string;
  port: number;
}

export interface EndpointDetailWithSecret extends EndpointDetail {
  connectionString: string;
}

export interface EndpointDetailWithOptionalSecret extends EndpointDetail {
  connectionString?: string;
}

export interface ConnectionEndpoints {
  direct?: EndpointDetail;
  pooled?: EndpointDetail;
  accelerate?: EndpointDetail;
}

export interface ConnectionEndpointsWithSecrets {
  direct?: EndpointDetailWithSecret;
  pooled?: EndpointDetailWithSecret;
  accelerate?: EndpointDetailWithSecret;
}

export interface ConnectionEndpointsWithOptionalSecrets {
  direct?: EndpointDetailWithOptionalSecret;
  pooled?: EndpointDetailWithOptionalSecret;
  accelerate?: EndpointDetailWithOptionalSecret;
}

export interface DatabaseConnection {
  id: string;
  type: "connection";
  url: string;
  name: string;
  createdAt: string;
  kind: "postgres" | "accelerate";
  endpoints: ConnectionEndpoints;
  database: ResourceRef;
}

export interface DatabaseConnectionWithSecrets extends Omit<
  DatabaseConnection,
  "endpoints"
> {
  endpoints: ConnectionEndpointsWithSecrets;
}

export interface DatabaseConnectionWithOptionalSecrets extends Omit<
  DatabaseConnection,
  "endpoints"
> {
  endpoints: ConnectionEndpointsWithOptionalSecrets;
}

export interface ConnectionCreateInput {
  databaseId: string;
  name: string;
}

export interface DatabaseConnectionCreateInput extends Omit<
  ConnectionCreateInput,
  "databaseId"
> {}

export type DatabaseSource =
  | { type: "empty" }
  | { type: "database"; databaseId: string }
  | { type: "backup"; databaseId: string; backupId: string };

export interface Database {
  id: string;
  type: "database";
  url: string;
  name: string;
  status: DatabaseStatus;
  createdAt: string;
  isDefault: boolean;
  defaultConnectionId: string | null;
  connections: DatabaseConnection[];
  project: ResourceRef;
  region: { id: string; name: string } | null;
  source: DatabaseSource | null;
  branchId: string | null;
}

export interface DatabaseCreateInput {
  projectId: string;
  name?: string;
  region?: PrismaDatabaseRegionId;
  isDefault?: boolean;
  source?: DatabaseSourceInput;
  branchId?: string | null;
  branchGitName?: string | null;
}

export type ProjectDatabaseCreateInput = Omit<
  DatabaseCreateInput,
  "projectId" | "branchId" | "branchGitName"
>;

export interface DatabaseUpdateInput {
  name?: string;
  branchId?: string | null;
  branchGitName?: string | null;
}

export type DatabaseSourceInput =
  | { type: "empty" }
  | { type: "database"; databaseId: string }
  | { type: "backup"; databaseId: string; backupId: string };

export interface Backup {
  id: string;
  type?: "backup";
  backupType: "full" | "incremental";
  createdAt: string;
  size?: number;
  status: "running" | "completed" | "failed" | "unknown";
}

export interface BackupListResponse {
  data: Backup[];
  meta: {
    backupRetentionDays: number;
  };
  pagination: {
    hasMore: boolean;
    limit: number | null;
  };
}

export interface DatabaseUsage {
  period: { start: string; end: string };
  metrics: {
    operations: { used: number; unit: "ops" };
    storage: { used: number; unit: "GiB" };
  };
  generatedAt: string;
}

export interface RestoreDatabaseInput {
  source: { type: "backup"; databaseId: string; backupId: string };
}

export interface RestoredDatabase extends Omit<Database, "source"> {
  source: Extract<DatabaseSource, { type: "backup" }>;
}

export interface Branch {
  id: string;
  type: "branch";
  url: string;
  gitName: string;
  isDefault: boolean;
  role: "production" | "preview";
  createdAt: string;
  updatedAt: string;
  project: ResourceRef;
}

export interface BranchCreateInput {
  gitName: string;
  isDefault?: boolean;
}

export interface BranchUpdateInput {
  isDefault?: boolean | null;
}

export interface DeploymentLogsQuery {
  /**
   * Number of trailing log lines to stream first.
   */
  tail?: number;
  /**
   * Start from the beginning of the log stream.
   */
  fromStart?: boolean;
  /**
   * Reconnect cursor returned by a terminal log event.
   */
  cursor?: string;
}

export interface DeploymentLogsRequest {
  /**
   * WebSocket URL for `/v1/deployments/{deploymentId}/logs`.
   */
  url: string;
  /**
   * Headers to pass to a WebSocket client that supports custom headers.
   */
  headers: {
    Authorization: Redacted.Redacted<string>;
  };
}

/** Query parameters for the authenticated build-log NDJSON stream. */
export interface BuildLogsQuery {
  /**
   * Keep following an in-flight build after the currently available records
   * have been drained.
   */
  follow?: boolean;
  /** Resume from the opaque cursor returned by a terminal record. */
  cursor?: string;
}

/** Authenticated HTTP request metadata for a build-log NDJSON stream. */
export interface BuildLogsRequest {
  /** HTTP(S) URL for `/v1/builds/{buildId}/logs`. */
  url: string;
  /** Headers required by the Management API build-log endpoint. */
  headers: {
    Authorization: Redacted.Redacted<string>;
    Accept: "application/x-ndjson";
  };
}

export interface BuildLogLine {
  type: "log";
  text: string;
  level: "info" | "error";
  source: "runner" | "stdout" | "stderr";
  step?: string;
  cursor: string;
}

export interface BuildLogTerminal {
  type: "terminal";
  kind: "end" | "error";
  code: string;
  message: string;
  retryable: boolean;
  cursor: string | null;
}

/** One JSON line returned by the build-log NDJSON stream. */
export type BuildLogRecord = BuildLogLine | BuildLogTerminal;

/** A Prisma App deployed through the canonical `/v1/apps` API. */
export interface App {
  id: string;
  type: "app";
  url: string;
  name: string;
  region: { id: string; name: string };
  projectId: string;
  branchId: string | null;
  latestDeploymentId: string | null;
  appEndpointDomain: string;
  createdAt: string;
}

export interface AppCreateInput {
  projectId: string;
  displayName: string;
  regionId?: PrismaRegionId;
  branchId?: string | null;
  branchGitName?: string | null;
}

export interface AppUpdateInput {
  displayName?: string;
  branchId?: string | null;
  branchGitName?: string | null;
}

/** Canonical deployment target for App promotion and rollback. */
export interface AppDeploymentTarget {
  deploymentId: string;
}

export interface PromoteAppResult {
  appEndpointDomain: string;
  reassignedDomains: number;
}

export interface RollbackAppResult {
  appEndpointDomain: string;
  reassignedDomains: number;
}

export interface DeploymentListItem {
  id: string;
  type: "deployment";
  url: string;
  foundryVersionId: string;
  createdAt: string;
}

/** Marker returned in place of every deployment environment secret value. */
export type RedactedDeploymentEnvironmentValue = "[redacted]";

export interface Deployment {
  id: string;
  type: "deployment";
  url: string;
  foundryVersionId: string;
  status: string;
  previewDomain: string | null;
  /**
   * Environment variable names captured by the deployment. Values are always
   * the literal redaction marker; the Management API never returns secrets.
   */
  envVars?: Record<string, RedactedDeploymentEnvironmentValue>;
  portMapping?: { http?: number };
  createdAt: string;
}

export interface DeploymentCreateInput {
  portMapping?: { http?: number | null };
  skipCodeUpload?: boolean;
}

export interface DeploymentCreateResult {
  id: string;
  type: "deployment";
  url: string;
  foundryVersionId: string;
  uploadUrl: string | null;
}

export interface StartDeploymentResult {
  previewDomain: string;
}

export type CustomDomainStatus =
  | "pending_dns"
  | "verifying"
  | "verified_routing_blocked"
  | "provisioning_tls"
  | "active"
  | "failed"
  | "removing";

export type CustomDomainFailureCategory =
  | "dns"
  | "acme"
  | "storage"
  | "unknown";

export interface CustomDomainDnsRecord {
  type: "CNAME";
  name: string;
  value: string;
  ttl: number | null;
}

export interface CustomDomain {
  id: string;
  type: "custom-domain";
  url: string;
  hostname: string;
  /** Current app identifier returned by the Management API. */
  appId: string;
  status: CustomDomainStatus;
  /** Raw custom-domain status returned by Foundry. */
  foundryStatus: string;
  failureReason: string | null;
  failureCategory: CustomDomainFailureCategory | null;
  certExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  dnsRecords: CustomDomainDnsRecord[];
}

export interface CustomDomainCreateInput {
  hostname: string;
}

/**
 * Status-aware result from the idempotent custom-domain create endpoint.
 * `200` means the hostname already existed on the App; only `201` proves that
 * this request created it.
 */
export type CustomDomainCreateResult =
  | { status: 200; domain: CustomDomain }
  | { status: 201; domain: CustomDomain };

export type EnvironmentVariableClass = "production" | "preview";

export interface EnvironmentVariable {
  id: string;
  type: "environment-variable";
  url: string;
  projectId: string;
  branchId: string | null;
  class: EnvironmentVariableClass;
  key: string;
  valueKid: string;
  isManagedBySystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariableCreateInput {
  projectId: string;
  branchId?: string;
  class: EnvironmentVariableClass;
  key: string;
  value: string;
}

export interface EnvironmentVariableUpdateInput {
  value: string;
}

export interface Integration {
  id: string;
  url: string;
  createdAt: string;
  scopes: string[];
  client: {
    id: string;
    name: string;
    createdAt: string;
  };
  createdByUser: {
    id: string;
    email: string;
    displayName: string | null;
  };
}

export interface ScmInstallation {
  id: string;
  type: "scm-installation";
  url: string;
  provider: "github";
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: "user" | "organization";
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScmInstallIntentCreateInput {
  provider: "github";
  workspaceId: string;
}

export interface ScmInstallIntent {
  type: "install-intent";
  provider: "github";
  workspaceId: string;
  installUrl: string;
}

export interface ScmRepository {
  id: number;
  type: "scm-repository";
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface SourceRepository {
  id: string;
  type: "source-repository";
  url: string;
  repoId: number;
  provider: "github";
  repoFullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  status: "active" | "archived";
  projectId: string;
  installationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRepositoryCreateInput {
  projectId: string;
  provider: "github";
  providerRepositoryId: number;
  installationId?: string;
}

export type BucketKeyRole = "read" | "read_write";

export interface Bucket {
  id: string;
  type: "bucket";
  url: string;
  name: string;
  providerName: string;
  status: string;
  createdAt: string;
  project: ResourceRef;
  branchId: string | null;
}

export interface BucketCreateInput {
  projectId: string;
  name?: string;
  branchId?: string;
  branchGitName?: string;
}

export interface BucketKey {
  id: string;
  type: "bucketKey";
  name: string;
  valueHint: string;
  role: BucketKeyRole;
  createdAt: string;
}

/**
 * Response from `POST /v1/buckets/{bucketId}/keys`. The `secretAccessKey`
 * is returned exactly once in this response and can never be re-read.
 */
export interface BucketKeyWithSecret extends BucketKey {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
}

export interface BucketKeyCreateInput {
  name?: string;
  role: BucketKeyRole;
}

export interface PrismaSecretConnection {
  directConnectionString?: Redacted.Redacted<string>;
  pooledConnectionString?: Redacted.Redacted<string>;
  accelerateConnectionString?: Redacted.Redacted<string>;
  host?: string | null;
  user?: string | null;
  password?: Redacted.Redacted<string>;
}
