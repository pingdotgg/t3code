import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PrismaEnvironment } from "./PrismaEnvironment.ts";
import type {
  App,
  AccelerateRegion,
  AppCreateInput,
  AppDeploymentTarget,
  AppUpdateInput,
  BackupListResponse,
  Branch,
  BranchCreateInput,
  BranchUpdateInput,
  Bucket,
  BucketCreateInput,
  BucketKey,
  BucketKeyCreateInput,
  BucketKeyWithSecret,
  BuildLogsQuery,
  BuildLogsRequest,
  ConnectionCreateInput,
  CurrentPrincipal,
  CustomDomain,
  CustomDomainCreateInput,
  CustomDomainCreateResult,
  DataResponse,
  Database,
  DatabaseConnection,
  DatabaseConnectionCreateInput,
  DatabaseConnectionWithOptionalSecrets,
  DatabaseConnectionWithSecrets,
  DatabaseCreateInput,
  DatabaseUpdateInput,
  DatabaseUsage,
  Deployment,
  DeploymentCreateInput,
  DeploymentCreateResult,
  DeploymentListItem,
  DeploymentLogsQuery,
  DeploymentLogsRequest,
  EnvironmentVariable,
  EnvironmentVariableCreateInput,
  EnvironmentVariableUpdateInput,
  Integration,
  ListResponse,
  PrismaBranchIdFilter,
  PrismaSecretConnection,
  Project,
  ProjectCreateInput,
  ProjectDatabaseCreateInput,
  ProjectTransferInput,
  ProjectUpdateInput,
  PostgresRegion,
  PromoteAppResult,
  RollbackAppResult,
  Region,
  RestoreDatabaseInput,
  RestoredDatabase,
  ScmInstallIntent,
  ScmInstallIntentCreateInput,
  ScmInstallation,
  ScmRepository,
  SourceRepository,
  SourceRepositoryCreateInput,
  StartDeploymentResult,
  Workspace,
} from "./Types.ts";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export class PrismaApiError extends Data.TaggedError("PrismaApiError")<{
  method: Method;
  path: string;
  status: number;
  message: string;
  /** Raw response bodies may contain credentials and are always redacted. */
  body?: Redacted.Redacted<string>;
}> {}

export class PrismaApiDecodeError extends Data.TaggedError(
  "PrismaApiDecodeError",
)<{
  method: Method;
  path: string;
  /** Byte length is retained for diagnostics without retaining response data. */
  bodyLength: number;
  message: string;
}> {}

interface RequestOptions {
  query?: object;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: Duration.Input;
  onSuccessfulBodyLength?: (
    bodyLength: number,
  ) => Effect.Effect<void, PrismaApiDecodeError>;
}

export interface PrismaManagementClient {
  listWorkspaces(
    query?: PaginationQuery,
  ): Effect.Effect<Workspace[], PrismaApiError | PrismaApiDecodeError>;
  getWorkspace(
    id: string,
  ): Effect.Effect<Workspace, PrismaApiError | PrismaApiDecodeError>;
  getCurrentPrincipal(): Effect.Effect<
    CurrentPrincipal,
    PrismaApiError | PrismaApiDecodeError
  >;
  listRegions(
    query?: RegionListQuery,
  ): Effect.Effect<Region[], PrismaApiError | PrismaApiDecodeError>;
  listPostgresRegions(): Effect.Effect<
    PostgresRegion[],
    PrismaApiError | PrismaApiDecodeError
  >;
  listAccelerateRegions(): Effect.Effect<
    AccelerateRegion[],
    PrismaApiError | PrismaApiDecodeError
  >;
  listProjects(
    query?: PaginationQuery,
  ): Effect.Effect<Project[], PrismaApiError | PrismaApiDecodeError>;
  getProject(
    id: string,
  ): Effect.Effect<Project, PrismaApiError | PrismaApiDecodeError>;
  createProject(
    input: ProjectCreateInput,
  ): Effect.Effect<ProjectCreateResult, PrismaApiError | PrismaApiDecodeError>;
  updateProject(
    id: string,
    input: ProjectUpdateInput,
  ): Effect.Effect<Project, PrismaApiError | PrismaApiDecodeError>;
  deleteProject(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  transferProject(
    id: string,
    input: ProjectTransferInput,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listDatabases(
    query?: DatabaseListQuery,
  ): Effect.Effect<Database[], PrismaApiError | PrismaApiDecodeError>;
  listProjectDatabases(
    projectId: string,
    query?: PaginationQuery,
  ): Effect.Effect<Database[], PrismaApiError | PrismaApiDecodeError>;
  getDatabase(
    id: string,
  ): Effect.Effect<Database, PrismaApiError | PrismaApiDecodeError>;
  createDatabase(
    input: DatabaseCreateInput,
  ): Effect.Effect<DatabaseCreateResult, PrismaApiError | PrismaApiDecodeError>;
  createProjectDatabase(
    projectId: string,
    input: ProjectDatabaseCreateInput,
  ): Effect.Effect<
    ProjectDatabaseCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  updateDatabase(
    id: string,
    input: DatabaseUpdateInput,
  ): Effect.Effect<Database, PrismaApiError | PrismaApiDecodeError>;
  deleteDatabase(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listBackups(
    databaseId: string,
    query?: BackupListQuery,
  ): Effect.Effect<BackupListResponse, PrismaApiError | PrismaApiDecodeError>;
  restoreDatabase(
    targetDatabaseId: string,
    input: RestoreDatabaseInput,
  ): Effect.Effect<RestoredDatabase, PrismaApiError | PrismaApiDecodeError>;
  getDatabaseUsage(
    databaseId: string,
    query?: DatabaseUsageQuery,
  ): Effect.Effect<DatabaseUsage, PrismaApiError | PrismaApiDecodeError>;
  listConnections(
    query?: ConnectionListQuery,
  ): Effect.Effect<DatabaseConnection[], PrismaApiError | PrismaApiDecodeError>;
  listDatabaseConnections(
    databaseId: string,
    query?: PaginationQuery,
  ): Effect.Effect<DatabaseConnection[], PrismaApiError | PrismaApiDecodeError>;
  getConnection(
    id: string,
  ): Effect.Effect<DatabaseConnection, PrismaApiError | PrismaApiDecodeError>;
  createConnection(
    input: ConnectionCreateInput,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  createDatabaseConnection(
    databaseId: string,
    input: DatabaseConnectionCreateInput,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  deleteConnection(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  rotateConnection(
    id: string,
  ): Effect.Effect<
    DatabaseConnectionWithSecrets,
    PrismaApiError | PrismaApiDecodeError
  >;
  listBranches(
    projectId: string,
    query?: BranchListQuery,
  ): Effect.Effect<Branch[], PrismaApiError | PrismaApiDecodeError>;
  getBranch(
    id: string,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  createBranch(
    projectId: string,
    input: BranchCreateInput,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  updateBranch(
    id: string,
    input: BranchUpdateInput,
  ): Effect.Effect<Branch, PrismaApiError | PrismaApiDecodeError>;
  deleteBranch(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listBuckets(
    query?: BucketListQuery,
  ): Effect.Effect<Bucket[], PrismaApiError | PrismaApiDecodeError>;
  getBucket(
    id: string,
  ): Effect.Effect<Bucket, PrismaApiError | PrismaApiDecodeError>;
  createBucket(
    input: BucketCreateInput,
  ): Effect.Effect<Bucket, PrismaApiError | PrismaApiDecodeError>;
  deleteBucket(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listBucketKeys(
    bucketId: string,
    query?: PaginationQuery,
  ): Effect.Effect<BucketKey[], PrismaApiError | PrismaApiDecodeError>;
  createBucketKey(
    bucketId: string,
    input: BucketKeyCreateInput,
  ): Effect.Effect<BucketKeyWithSecret, PrismaApiError | PrismaApiDecodeError>;
  deleteBucketKey(
    bucketId: string,
    keyId: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  getCustomDomain(
    id: string,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  deleteCustomDomain(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  retryCustomDomain(
    id: string,
  ): Effect.Effect<CustomDomain, PrismaApiError | PrismaApiDecodeError>;
  listApps(
    query?: AppListQuery,
  ): Effect.Effect<App[], PrismaApiError | PrismaApiDecodeError>;
  getApp(id: string): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  createApp(
    input: AppCreateInput,
  ): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  updateApp(
    id: string,
    input: AppUpdateInput,
  ): Effect.Effect<App, PrismaApiError | PrismaApiDecodeError>;
  deleteApp(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  promoteApp(
    id: string,
    target: AppDeploymentTarget,
  ): Effect.Effect<PromoteAppResult, PrismaApiError | PrismaApiDecodeError>;
  rollbackApp(
    id: string,
    target: AppDeploymentTarget,
  ): Effect.Effect<RollbackAppResult, PrismaApiError | PrismaApiDecodeError>;
  listAppDomains(
    appId: string,
  ): Effect.Effect<CustomDomain[], PrismaApiError | PrismaApiDecodeError>;
  createAppDomain(
    appId: string,
    input: CustomDomainCreateInput,
  ): Effect.Effect<
    CustomDomainCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  listAppDeployments(
    appId: string,
    query?: PaginationQuery,
  ): Effect.Effect<DeploymentListItem[], PrismaApiError | PrismaApiDecodeError>;
  createAppDeployment(
    appId: string,
    input?: DeploymentCreateInput,
  ): Effect.Effect<
    DeploymentCreateResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  getDeployment(
    id: string,
  ): Effect.Effect<Deployment, PrismaApiError | PrismaApiDecodeError>;
  deleteDeployment(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  startDeployment(
    id: string,
  ): Effect.Effect<
    StartDeploymentResult,
    PrismaApiError | PrismaApiDecodeError
  >;
  stopDeployment(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  getDeploymentLogsRequest(
    id: string,
    query?: DeploymentLogsQuery,
  ): Effect.Effect<DeploymentLogsRequest, PrismaApiError>;
  getBuildLogsRequest(
    buildId: string,
    query?: BuildLogsQuery,
  ): Effect.Effect<BuildLogsRequest, PrismaApiError>;
  listEnvironmentVariables(
    query?: EnvironmentVariableListQuery,
  ): Effect.Effect<
    EnvironmentVariable[],
    PrismaApiError | PrismaApiDecodeError
  >;
  getEnvironmentVariable(
    id: string,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  createEnvironmentVariable(
    input: EnvironmentVariableCreateInput,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  updateEnvironmentVariable(
    id: string,
    input: EnvironmentVariableUpdateInput,
  ): Effect.Effect<EnvironmentVariable, PrismaApiError | PrismaApiDecodeError>;
  deleteEnvironmentVariable(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listIntegrations(
    query: IntegrationListQuery,
  ): Effect.Effect<Integration[], PrismaApiError | PrismaApiDecodeError>;
  listWorkspaceIntegrations(
    workspaceId: string,
    query?: PaginationQuery,
  ): Effect.Effect<Integration[], PrismaApiError | PrismaApiDecodeError>;
  getIntegration(
    id: string,
  ): Effect.Effect<Integration, PrismaApiError | PrismaApiDecodeError>;
  deleteIntegration(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  revokeWorkspaceIntegration(
    workspaceId: string,
    clientId: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
  listScmInstallations(query: {
    workspaceId: string;
    cursor?: string | null;
    limit?: number;
  }): Effect.Effect<ScmInstallation[], PrismaApiError | PrismaApiDecodeError>;
  createScmInstallIntent(
    input: ScmInstallIntentCreateInput,
  ): Effect.Effect<ScmInstallIntent, PrismaApiError | PrismaApiDecodeError>;
  listScmInstallationRepositories(
    installationId: string,
    query?: PaginationQuery,
  ): Effect.Effect<ScmRepository[], PrismaApiError | PrismaApiDecodeError>;
  listSourceRepositories(
    query: SourceRepositoryListQuery,
  ): Effect.Effect<SourceRepository[], PrismaApiError | PrismaApiDecodeError>;
  getSourceRepository(
    id: string,
  ): Effect.Effect<SourceRepository, PrismaApiError | PrismaApiDecodeError>;
  createSourceRepository(
    input: SourceRepositoryCreateInput,
  ): Effect.Effect<SourceRepository, PrismaApiError | PrismaApiDecodeError>;
  deleteSourceRepository(
    id: string,
  ): Effect.Effect<void, PrismaApiError | PrismaApiDecodeError>;
}

export class PrismaClient extends Context.Service<
  PrismaClient,
  PrismaManagementClient
>()("Prisma::PrismaClient") {}

export interface PaginationQuery {
  cursor?: string | null;
  limit?: number;
}

export interface BackupListQuery {
  limit?: number;
}

export interface DatabaseUsageQuery {
  startDate?: string;
  endDate?: string;
}

export interface RegionListQuery {
  product?: "postgres" | "accelerate";
}

export interface DatabaseListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export interface ConnectionListQuery extends PaginationQuery {
  databaseId?: string;
}

export interface BranchListQuery extends PaginationQuery {
  gitName?: string;
  gitNameContains?: string;
}

export interface BucketListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export interface AppListQuery extends PaginationQuery {
  projectId?: string;
  branchId?: PrismaBranchIdFilter;
  branchGitName?: string;
}

export type {
  BuildLogsQuery,
  BuildLogsRequest,
  DeploymentLogsQuery,
  DeploymentLogsRequest,
};

export interface EnvironmentVariableListQuery extends PaginationQuery {
  projectId?: string;
  class?: "production" | "preview";
  key?: string;
  branchId?: string;
}

export interface IntegrationListQuery extends PaginationQuery {
  workspaceId: string;
}

export interface SourceRepositoryListQuery extends PaginationQuery {
  projectId: string;
}

/** Response from the flat `POST /v1/databases` operation. */
export interface DatabaseCreateResult extends Omit<Database, "connections"> {
  connections: DatabaseConnectionWithOptionalSecrets[];
}

/** Response from `POST /v1/projects/{projectId}/databases`. */
export interface ProjectDatabaseCreateResult extends Omit<
  DatabaseCreateResult,
  "region" | "status"
> {
  status: "provisioning" | "ready";
  region: { id: string; name: string };
}

export interface ProjectCreateDatabaseResult extends Omit<
  ProjectDatabaseCreateResult,
  "project"
> {}

export interface ProjectCreateResult extends Project {
  database: ProjectCreateDatabaseResult | null;
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof PrismaApiError && error.status === 404;

export const isConflict = (error: unknown): boolean =>
  error instanceof PrismaApiError && error.status === 409;

const redactedString = (
  value: unknown,
): Redacted.Redacted<string> | undefined =>
  typeof value === "string" ? Redacted.make(value) : undefined;

const decodeUrlComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const extractConnectionSecrets = (
  connection:
    | DatabaseConnection
    | DatabaseConnectionWithOptionalSecrets
    | DatabaseConnectionWithSecrets
    | undefined
    | null,
): PrismaSecretConnection => {
  if (!connection) return {};
  const withSecrets = connection as DatabaseConnectionWithOptionalSecrets;
  const direct = withSecrets.endpoints?.direct?.connectionString;
  const pooled = withSecrets.endpoints?.pooled?.connectionString;
  const accelerate = withSecrets.endpoints?.accelerate?.connectionString;
  const directUrl = (() => {
    if (!direct) return undefined;
    try {
      return new URL(direct);
    } catch {
      return undefined;
    }
  })();
  return {
    directConnectionString: redactedString(direct),
    pooledConnectionString: redactedString(pooled),
    accelerateConnectionString: redactedString(accelerate),
    host: directUrl?.hostname ?? withSecrets.endpoints?.direct?.host ?? null,
    user: directUrl?.username ? decodeUrlComponent(directUrl.username) : null,
    password: directUrl?.password
      ? redactedString(decodeUrlComponent(directUrl.password))
      : undefined,
  };
};

export const requestBody = <T>(response: DataResponse<T>): T => response.data;

const isRetryableStatus = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;

const REQUEST_AND_BODY_TIMEOUT = "10 seconds" as const;
const MAX_SUCCESS_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_PAGINATION_PAGES = 1_000;
const MAX_PAGINATION_ITEMS = 100_000;
const MAX_PAGINATION_BODY_BYTES = 64 * 1024 * 1024;
const PAGINATION_TIMEOUT = "2 minutes" as const;
const ROLLBACK_REQUEST_TIMEOUT = "30 seconds" as const;
const PROVISIONING_REQUEST_TIMEOUT = "2 minutes" as const;
const INVALID_PATH_SEGMENT = "__alchemy_invalid_prisma_path_segment__";

const pathSegment = (value: string): string => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value === INVALID_PATH_SEGMENT ||
    /[\\/?#%]/.test(value) ||
    value.includes("\0")
  ) {
    return INVALID_PATH_SEGMENT;
  }
  try {
    return encodeURIComponent(value);
  } catch {
    return INVALID_PATH_SEGMENT;
  }
};

const isRetryablePost = (path: string) =>
  path.endsWith("/start") ||
  path.endsWith("/stop") ||
  path.endsWith("/promote") ||
  path.endsWith("/rollback");

const isRetryableRequest = (method: Method, path: string) =>
  method === "GET" ||
  method === "DELETE" ||
  method === "PATCH" ||
  (method === "POST" && isRetryablePost(path));

const retryTransient = <A, E, R>(
  method: Method,
  path: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e instanceof PrismaApiError &&
        isRetryableRequest(method, path) &&
        isRetryableStatus(e.status),
      schedule: Schedule.max([
        Schedule.exponential("100 millis"),
        Schedule.recurs(4),
      ]),
    }),
  );

function makePrismaClient(): Effect.Effect<
  PrismaManagementClient,
  never,
  PrismaEnvironment | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const env = yield* PrismaEnvironment;
    const http = yield* HttpClient.HttpClient;

    function isValidApiPath(path: string): boolean {
      if (
        (path !== "/v1" && !path.startsWith("/v1/")) ||
        path.startsWith("//") ||
        path.includes("\\") ||
        path.includes("?") ||
        path.includes("#") ||
        path.includes(INVALID_PATH_SEGMENT)
      ) {
        return false;
      }
      try {
        const base = new URL(env.baseUrl);
        const resolved = new URL(path, base);
        return (
          resolved.origin === base.origin &&
          (resolved.pathname === "/v1" || resolved.pathname.startsWith("/v1/"))
        );
      } catch {
        return false;
      }
    }

    const buildUrl = (
      path: string,
      query?: object,
    ): Effect.Effect<string, PrismaApiError> => {
      if (!isValidApiPath(path)) {
        return Effect.fail(
          new PrismaApiError({
            method: "GET",
            path,
            status: 0,
            message: "Refused an invalid Prisma Management API path parameter",
          }),
        );
      }
      return Effect.sync(() => {
        const url = new URL(path, env.baseUrl);
        for (const [key, value] of Object.entries(query ?? {})) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) {
            for (const item of value) {
              url.searchParams.append(key, String(item));
            }
          } else {
            url.searchParams.set(key, String(value));
          }
        }
        return url.toString();
      });
    };

    const buildWebSocketUrl = (path: string, query?: object) =>
      buildUrl(path, query).pipe(
        Effect.map((value) => {
          const url = new URL(value);
          if (url.protocol === "https:") url.protocol = "wss:";
          if (url.protocol === "http:") url.protocol = "ws:";
          return url.toString();
        }),
      );

    const logsQuery = (
      query: DeploymentLogsQuery | undefined,
    ): Record<string, unknown> | undefined => {
      if (!query) return undefined;
      const { fromStart, ...rest } = query;
      return {
        ...rest,
        from_start: fromStart === undefined ? undefined : String(fromStart),
      };
    };

    const makeRequest = (
      method: Method,
      url: string,
      options: RequestOptions | undefined,
    ) => {
      const init =
        method === "GET"
          ? HttpClientRequest.get(url)
          : method === "POST"
            ? HttpClientRequest.post(url)
            : method === "PATCH"
              ? HttpClientRequest.patch(url)
              : HttpClientRequest.delete(url);
      const request = init.pipe(
        HttpClientRequest.bearerToken(Redacted.value(env.serviceToken)),
        HttpClientRequest.setHeaders({
          Accept: "application/json",
          "User-Agent": "alchemy-prisma/1.0",
          ...options?.headers,
        }),
      );
      return options?.body === undefined
        ? request
        : request.pipe(HttpClientRequest.bodyJsonUnsafe(options.body));
    };

    const requestWithStatus = <T>(
      method: Method,
      path: string,
      options?: RequestOptions,
    ): Effect.Effect<
      { status: number; body: T },
      PrismaApiError | PrismaApiDecodeError
    > => {
      if (!isValidApiPath(path)) {
        return Effect.fail(
          new PrismaApiError({
            method,
            path,
            status: 0,
            message:
              "Refused an invalid Prisma Management API path or path parameter outside the configured /v1 origin",
          }),
        );
      }
      return retryTransient(
        method,
        path,
        Effect.gen(function* () {
          const url = yield* buildUrl(path, options?.query);
          const req = makeRequest(method, url, options);
          const response = Effect.gen(function* () {
            const res = yield* http.execute(req).pipe(
              Effect.mapError(
                (e) =>
                  new PrismaApiError({
                    method,
                    path,
                    status: 0,
                    message: e instanceof Error ? e.message : String(e),
                  }),
              ),
            );

            const maxBodyBytes =
              res.status >= 200 && res.status < 300
                ? MAX_SUCCESS_BODY_BYTES
                : MAX_ERROR_BODY_BYTES;
            const bodyTooLarge = (bodyLength: number) =>
              res.status >= 200 && res.status < 300
                ? new PrismaApiDecodeError({
                    method,
                    path,
                    bodyLength,
                    message: `Prisma Management API response exceeded the ${maxBodyBytes} byte safety limit`,
                  })
                : new PrismaApiError({
                    method,
                    path,
                    status: res.status,
                    message: `Prisma Management API error response exceeded the ${maxBodyBytes} byte safety limit`,
                  });
            const declaredLength = Number(res.headers["content-length"]);
            if (
              Number.isSafeInteger(declaredLength) &&
              declaredLength > maxBodyBytes
            ) {
              return yield* bodyTooLarge(declaredLength);
            }

            const collected = yield* Stream.runFoldEffect(
              res.stream,
              () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
              (state, chunk) => {
                const bytes = state.bytes + chunk.byteLength;
                if (bytes > maxBodyBytes) {
                  return Effect.fail(bodyTooLarge(bytes));
                }
                state.chunks.push(chunk);
                state.bytes = bytes;
                return Effect.succeed(state);
              },
            ).pipe(
              Effect.catch((error) => {
                if (
                  error instanceof PrismaApiError ||
                  error instanceof PrismaApiDecodeError
                ) {
                  return Effect.fail(error);
                }
                if (
                  HttpClientError.isHttpClientError(error) &&
                  error.reason._tag === "EmptyBodyError"
                ) {
                  return Effect.succeed({
                    chunks: [] as Uint8Array[],
                    bytes: 0,
                  });
                }
                return Effect.fail(
                  new PrismaApiError({
                    method,
                    path,
                    status: 0,
                    message: `Failed to read Prisma Management API response: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  }),
                );
              }),
            );
            const bytes = new Uint8Array(collected.bytes);
            let offset = 0;
            for (const chunk of collected.chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const text = new TextDecoder().decode(bytes);
            return { status: res.status, text, bodyLength: collected.bytes };
          });
          const { status, text, bodyLength } = yield* response;
          if (status < 200 || status >= 300) {
            return yield* new PrismaApiError({
              method,
              path,
              status,
              message: formatErrorMessage(status, text),
              body: text.length === 0 ? undefined : Redacted.make(text),
            });
          }
          if (options?.onSuccessfulBodyLength !== undefined) {
            yield* options.onSuccessfulBodyLength(bodyLength);
          }
          if (status === 204 || text.length === 0) {
            return { status, body: undefined as T };
          }
          const body = yield* Effect.try({
            try: () => JSON.parse(text) as T,
            catch: () =>
              new PrismaApiDecodeError({
                method,
                path,
                bodyLength: new TextEncoder().encode(text).byteLength,
                message: "Prisma Management API returned invalid JSON",
              }),
          });
          return { status, body };
        }),
      ).pipe(
        // The deadline covers the complete operation, including transient
        // retries and streaming the response body. A per-attempt timeout would
        // multiply the advertised deadline and can leave a hung peer tying up
        // a deployment for every retry slot.
        Effect.timeoutOrElse({
          duration: options?.timeout ?? REQUEST_AND_BODY_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new PrismaApiError({
                method,
                path,
                status: 0,
                message:
                  options?.timeout === undefined
                    ? `Prisma Management API request timed out after ${REQUEST_AND_BODY_TIMEOUT}`
                    : "Prisma Management API request timed out at the operation-specific deadline",
              }),
            ),
        }),
      );
    };

    const request = <T>(
      method: Method,
      path: string,
      options?: RequestOptions,
    ): Effect.Effect<T, PrismaApiError | PrismaApiDecodeError> =>
      requestWithStatus<T>(method, path, options).pipe(
        Effect.map(({ body }) => body),
      );

    const dataWithStatus = <T>(
      method: Method,
      path: string,
      options?: RequestOptions,
    ) =>
      requestWithStatus<unknown>(method, path, options).pipe(
        Effect.flatMap(({ status, body: response }) =>
          response !== null &&
          typeof response === "object" &&
          Object.hasOwn(response, "data")
            ? Effect.succeed({
                status,
                data: requestBody(response as DataResponse<T>),
              })
            : Effect.fail(
                new PrismaApiDecodeError({
                  method,
                  path,
                  bodyLength: 0,
                  message:
                    "Prisma Management API response did not contain a data envelope",
                }),
              ),
        ),
      );

    const data = <T>(method: Method, path: string, options?: RequestOptions) =>
      dataWithStatus<T>(method, path, options).pipe(
        Effect.map(({ data }) => data),
      );

    const list = <T>(
      path: string,
      query?: object,
      onSuccessfulBodyLength?: RequestOptions["onSuccessfulBodyLength"],
    ) =>
      request<ListResponse<T>>("GET", path, {
        query,
        onSuccessfulBodyLength,
      });

    const paginate = <T>(path: string, query?: object) =>
      Effect.suspend(() => {
        let observedPages = 0;
        let observedItems = 0;
        let observedBodyBytes = 0;
        let observedCursor = false;
        return Effect.gen(function* () {
          const items: T[] = [];
          const queryRecord = query as { cursor?: unknown } | undefined;
          let cursor =
            typeof queryRecord?.cursor === "string"
              ? queryRecord.cursor
              : undefined;
          const seenCursors = new Set<string>();
          if (cursor !== undefined) seenCursors.add(cursor);
          observedCursor = cursor !== undefined;

          const protocolError = (message: string) =>
            new PrismaApiDecodeError({
              method: "GET",
              path,
              bodyLength: 0,
              message: `Invalid Prisma Management API pagination response: ${message}`,
            });
          const accountForBody = (bodyLength: number) => {
            const aggregateBodyLength = observedBodyBytes + bodyLength;
            if (aggregateBodyLength > MAX_PAGINATION_BODY_BYTES) {
              return Effect.fail(
                new PrismaApiDecodeError({
                  method: "GET",
                  path,
                  bodyLength: aggregateBodyLength,
                  message: `Invalid Prisma Management API pagination response: exceeded the ${MAX_PAGINATION_BODY_BYTES} aggregate response byte safety limit`,
                }),
              );
            }
            observedBodyBytes = aggregateBodyLength;
            return Effect.void;
          };

          while (true) {
            if (observedPages >= MAX_PAGINATION_PAGES) {
              return yield* protocolError(
                `exceeded the ${MAX_PAGINATION_PAGES} page safety limit`,
              );
            }
            const page = yield* list<T>(
              path,
              { ...query, cursor },
              accountForBody,
            );
            observedPages += 1;

            if (
              page === null ||
              typeof page !== "object" ||
              !Array.isArray(page.data) ||
              page.pagination === null ||
              typeof page.pagination !== "object" ||
              typeof page.pagination.hasMore !== "boolean"
            ) {
              return yield* protocolError(
                "expected data[] and pagination.hasMore",
              );
            }
            if (page.data.length > MAX_PAGINATION_ITEMS - items.length) {
              return yield* protocolError(
                `exceeded the ${MAX_PAGINATION_ITEMS} item safety limit`,
              );
            }
            items.push(...page.data);
            observedItems = items.length;

            if (!page.pagination.hasMore) return items;
            const nextCursor = page.pagination.nextCursor;
            if (typeof nextCursor !== "string" || nextCursor.length === 0) {
              return yield* protocolError(
                "hasMore was true without a non-empty nextCursor",
              );
            }
            if (seenCursors.has(nextCursor)) {
              return yield* protocolError("nextCursor repeated");
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
            observedCursor = true;
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: PAGINATION_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new PrismaApiError({
                  method: "GET",
                  path,
                  status: 0,
                  message: `Prisma Management API pagination timed out after ${PAGINATION_TIMEOUT} (${observedPages} pages, ${observedItems} items, ${observedBodyBytes} response bytes, cursor ${observedCursor ? "present" : "absent"})`,
                }),
              ),
          }),
        );
      });

    const service = {
      listWorkspaces: (query) => paginate<Workspace>("/v1/workspaces", query),
      getWorkspace: (id) =>
        data<Workspace>("GET", `/v1/workspaces/${pathSegment(id)}`),
      getCurrentPrincipal: () => data<CurrentPrincipal>("GET", "/v1/me"),
      listRegions: (query) => data<Region[]>("GET", "/v1/regions", { query }),
      listPostgresRegions: () =>
        data<PostgresRegion[]>("GET", "/v1/regions/postgres"),
      listAccelerateRegions: () =>
        data<AccelerateRegion[]>("GET", "/v1/regions/accelerate"),

      listProjects: (query) => paginate<Project>("/v1/projects", query),
      getProject: (id) =>
        data<Project>("GET", `/v1/projects/${pathSegment(id)}`),
      createProject: (input) =>
        data<ProjectCreateResult>("POST", "/v1/projects", {
          body: input,
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      updateProject: (id, input) =>
        data<Project>("PATCH", `/v1/projects/${pathSegment(id)}`, {
          body: input,
        }),
      deleteProject: (id) =>
        request<void>("DELETE", `/v1/projects/${pathSegment(id)}`, {
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      transferProject: (id, input) =>
        request<void>("POST", `/v1/projects/${pathSegment(id)}/transfer`, {
          body: input,
        }),

      listDatabases: (query) => paginate<Database>("/v1/databases", query),
      listProjectDatabases: (projectId, query) =>
        paginate<Database>(
          `/v1/projects/${pathSegment(projectId)}/databases`,
          query,
        ),
      getDatabase: (id) =>
        data<Database>("GET", `/v1/databases/${pathSegment(id)}`),
      createDatabase: (input) =>
        data<DatabaseCreateResult>("POST", "/v1/databases", {
          body: input,
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      createProjectDatabase: (projectId, input) =>
        data<ProjectDatabaseCreateResult>(
          "POST",
          `/v1/projects/${pathSegment(projectId)}/databases`,
          { body: input, timeout: PROVISIONING_REQUEST_TIMEOUT },
        ),
      updateDatabase: (id, input) =>
        data<Database>("PATCH", `/v1/databases/${pathSegment(id)}`, {
          body: input,
        }),
      deleteDatabase: (id) =>
        request<void>("DELETE", `/v1/databases/${pathSegment(id)}`, {
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      listBackups: (databaseId, query) =>
        request<BackupListResponse>(
          "GET",
          `/v1/databases/${pathSegment(databaseId)}/backups`,
          { query },
        ),
      restoreDatabase: (targetDatabaseId, input) =>
        data<RestoredDatabase>(
          "POST",
          `/v1/databases/${pathSegment(targetDatabaseId)}/restore`,
          { body: input, timeout: PROVISIONING_REQUEST_TIMEOUT },
        ),
      getDatabaseUsage: (databaseId, query) =>
        request<DatabaseUsage>(
          "GET",
          `/v1/databases/${pathSegment(databaseId)}/usage`,
          { query },
        ),

      listConnections: (query) =>
        paginate<DatabaseConnection>("/v1/connections", query),
      listDatabaseConnections: (databaseId, query) =>
        paginate<DatabaseConnection>(
          `/v1/databases/${pathSegment(databaseId)}/connections`,
          query,
        ),
      getConnection: (id) =>
        data<DatabaseConnection>("GET", `/v1/connections/${pathSegment(id)}`),
      createConnection: (input) =>
        data<DatabaseConnectionWithSecrets>("POST", "/v1/connections", {
          body: input,
        }),
      createDatabaseConnection: (databaseId, input) =>
        data<DatabaseConnectionWithSecrets>(
          "POST",
          `/v1/databases/${pathSegment(databaseId)}/connections`,
          { body: input },
        ),
      deleteConnection: (id) =>
        request<void>("DELETE", `/v1/connections/${pathSegment(id)}`),
      rotateConnection: (id) =>
        data<DatabaseConnectionWithSecrets>(
          "POST",
          `/v1/connections/${pathSegment(id)}/rotate`,
        ),

      listBranches: (projectId, query) =>
        paginate<Branch>(
          `/v1/projects/${pathSegment(projectId)}/branches`,
          query,
        ),
      getBranch: (id) => data<Branch>("GET", `/v1/branches/${pathSegment(id)}`),
      createBranch: (projectId, input) =>
        data<Branch>(
          "POST",
          `/v1/projects/${pathSegment(projectId)}/branches`,
          {
            body: input,
          },
        ),
      updateBranch: (id, input) =>
        data<Branch>("PATCH", `/v1/branches/${pathSegment(id)}`, {
          body: input,
        }),
      deleteBranch: (id) =>
        request<void>("DELETE", `/v1/branches/${pathSegment(id)}`),

      listBuckets: (query) => paginate<Bucket>("/v1/buckets", query),
      getBucket: (id) => data<Bucket>("GET", `/v1/buckets/${pathSegment(id)}`),
      createBucket: (input) =>
        data<Bucket>("POST", "/v1/buckets", { body: input }),
      deleteBucket: (id) =>
        request<void>("DELETE", `/v1/buckets/${pathSegment(id)}`),
      listBucketKeys: (bucketId, query) =>
        paginate<BucketKey>(`/v1/buckets/${pathSegment(bucketId)}/keys`, query),
      createBucketKey: (bucketId, input) =>
        data<BucketKeyWithSecret>(
          "POST",
          `/v1/buckets/${pathSegment(bucketId)}/keys`,
          { body: input },
        ),
      deleteBucketKey: (bucketId, keyId) =>
        request<void>(
          "DELETE",
          `/v1/buckets/${pathSegment(bucketId)}/keys/${pathSegment(keyId)}`,
        ),

      getCustomDomain: (id) =>
        data<CustomDomain>("GET", `/v1/domains/${pathSegment(id)}`),
      deleteCustomDomain: (id) =>
        request<void>("DELETE", `/v1/domains/${pathSegment(id)}`),
      retryCustomDomain: (id) =>
        data<CustomDomain>("POST", `/v1/domains/${pathSegment(id)}/retry`),

      listApps: (query) => paginate<App>("/v1/apps", query),
      getApp: (id) => data<App>("GET", `/v1/apps/${pathSegment(id)}`),
      createApp: (input) =>
        data<App>("POST", "/v1/apps", {
          body: input,
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      updateApp: (id, input) =>
        data<App>("PATCH", `/v1/apps/${pathSegment(id)}`, { body: input }),
      deleteApp: (id) =>
        request<void>("DELETE", `/v1/apps/${pathSegment(id)}`, {
          timeout: PROVISIONING_REQUEST_TIMEOUT,
        }),
      promoteApp: (id, target) =>
        data<PromoteAppResult>("POST", `/v1/apps/${pathSegment(id)}/promote`, {
          body: target,
        }),
      rollbackApp: (id, target) =>
        data<RollbackAppResult>(
          "POST",
          `/v1/apps/${pathSegment(id)}/rollback`,
          {
            body: target,
            timeout: ROLLBACK_REQUEST_TIMEOUT,
          },
        ),
      listAppDomains: (appId) =>
        paginate<CustomDomain>(`/v1/apps/${pathSegment(appId)}/domains`),
      createAppDomain: (appId, input) => {
        const path = `/v1/apps/${pathSegment(appId)}/domains`;
        return dataWithStatus<CustomDomain>("POST", path, {
          body: input,
        }).pipe(
          Effect.flatMap(({ status, data: domain }) =>
            status === 200 || status === 201
              ? Effect.succeed({ status, domain })
              : Effect.fail(
                  new PrismaApiDecodeError({
                    method: "POST",
                    path,
                    bodyLength: 0,
                    message: `Prisma Management API returned unexpected HTTP ${status} for custom-domain creation`,
                  }),
                ),
          ),
        );
      },
      listAppDeployments: (appId, query) =>
        paginate<DeploymentListItem>(
          `/v1/apps/${pathSegment(appId)}/deployments`,
          query,
        ),
      createAppDeployment: (appId, input) =>
        data<DeploymentCreateResult>(
          "POST",
          `/v1/apps/${pathSegment(appId)}/deployments`,
          input === undefined ? undefined : { body: input },
        ),
      getDeployment: (id) =>
        data<Deployment>("GET", `/v1/deployments/${pathSegment(id)}`),
      deleteDeployment: (id) =>
        request<void>("DELETE", `/v1/deployments/${pathSegment(id)}`),
      startDeployment: (id) =>
        data<StartDeploymentResult>(
          "POST",
          `/v1/deployments/${pathSegment(id)}/start`,
        ),
      stopDeployment: (id) =>
        request<void>("POST", `/v1/deployments/${pathSegment(id)}/stop`),
      getDeploymentLogsRequest: (id, query) =>
        buildWebSocketUrl(
          `/v1/deployments/${pathSegment(id)}/logs`,
          logsQuery(query),
        ).pipe(
          Effect.map((url): DeploymentLogsRequest => ({
            url,
            headers: {
              Authorization: Redacted.make(
                `Bearer ${Redacted.value(env.serviceToken)}`,
              ),
            },
          })),
        ),
      getBuildLogsRequest: (buildId, query) =>
        buildUrl(`/v1/builds/${pathSegment(buildId)}/logs`, query).pipe(
          Effect.map((url): BuildLogsRequest => ({
            url,
            headers: {
              Authorization: Redacted.make(
                `Bearer ${Redacted.value(env.serviceToken)}`,
              ),
              Accept: "application/x-ndjson",
            },
          })),
        ),

      listEnvironmentVariables: (query) =>
        paginate<EnvironmentVariable>("/v1/environment-variables", query),
      getEnvironmentVariable: (id) =>
        data<EnvironmentVariable>(
          "GET",
          `/v1/environment-variables/${pathSegment(id)}`,
        ),
      createEnvironmentVariable: (input) =>
        data<EnvironmentVariable>("POST", "/v1/environment-variables", {
          body: input,
        }),
      updateEnvironmentVariable: (id, input) =>
        data<EnvironmentVariable>(
          "PATCH",
          `/v1/environment-variables/${pathSegment(id)}`,
          { body: input },
        ),
      deleteEnvironmentVariable: (id) =>
        request<void>("DELETE", `/v1/environment-variables/${pathSegment(id)}`),

      listIntegrations: (query) =>
        paginate<Integration>("/v1/integrations", query),
      listWorkspaceIntegrations: (workspaceId, query) =>
        paginate<Integration>(
          `/v1/workspaces/${pathSegment(workspaceId)}/integrations`,
          query,
        ),
      getIntegration: (id) =>
        data<Integration>("GET", `/v1/integrations/${pathSegment(id)}`),
      deleteIntegration: (id) =>
        request<void>("DELETE", `/v1/integrations/${pathSegment(id)}`),
      revokeWorkspaceIntegration: (workspaceId, clientId) =>
        request<void>(
          "DELETE",
          `/v1/workspaces/${pathSegment(workspaceId)}/integrations/${pathSegment(clientId)}`,
        ),

      listScmInstallations: (query) =>
        paginate<ScmInstallation>("/v1/scm-installations", query),
      createScmInstallIntent: (input) =>
        data<ScmInstallIntent>(
          "POST",
          "/v1/scm-installations/install-intents",
          {
            body: input,
          },
        ),
      listScmInstallationRepositories: (installationId, query) =>
        paginate<ScmRepository>(
          `/v1/scm-installations/${pathSegment(installationId)}/repositories`,
          query,
        ),

      listSourceRepositories: (query) =>
        paginate<SourceRepository>("/v1/source-repositories", query),
      getSourceRepository: (id) =>
        data<SourceRepository>(
          "GET",
          `/v1/source-repositories/${pathSegment(id)}`,
        ),
      createSourceRepository: (input) =>
        data<SourceRepository>("POST", "/v1/source-repositories", {
          body: input,
        }),
      deleteSourceRepository: (id) =>
        request<void>("DELETE", `/v1/source-repositories/${pathSegment(id)}`),
    } satisfies PrismaManagementClient;
    return service;
  });
}

const SAFE_ERROR_CODE = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;

const parseErrorCode = (body: string): string | undefined => {
  if (body.length === 0) return undefined;
  try {
    const json = JSON.parse(body) as {
      code?: unknown;
      error?: unknown;
    };
    const nested =
      json.error !== null && typeof json.error === "object"
        ? (json.error as { code?: unknown }).code
        : undefined;
    const code = json.code ?? nested;
    return typeof code === "string" && SAFE_ERROR_CODE.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
};

const formatErrorMessage = (status: number, body: string): string => {
  const code = parseErrorCode(body);
  return code === undefined
    ? `HTTP ${status}`
    : `Prisma Management API request failed (${code})`;
};

export const PrismaClientLive = Layer.effect(PrismaClient, makePrismaClient());
