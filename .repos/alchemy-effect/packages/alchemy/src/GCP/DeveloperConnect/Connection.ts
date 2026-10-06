import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ServiceDirectoryConfig = {
  /**
   * Service Directory service used to reach a private host, as
   * `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}`.
   */
  service?: string;
};

export type UserCredential = {
  /**
   * Secret Manager resource containing the user token, as
   * `projects/{project}/secrets/{secret}/versions/{version}`.
   */
  userTokenSecretVersion?: string;
};

export type OAuthCredential = {
  /**
   * Secret Manager resource containing the OAuth token that authorizes
   * the connection.
   */
  oauthTokenSecretVersion?: string;
};

export type GitHubConfig = {
  /**
   * GitHub App that was installed (`DEVELOPER_CONNECT`, `FIREBASE`,
   * `GEMINI_CODE_ASSIST`, `DATAFORM`). Immutable — changing it
   * replaces the connection.
   * @default "DEVELOPER_CONNECT"
   */
  githubApp?: developerconnect.GitHubConfigGithubAppEnum | (string & {});
  /**
   * OAuth credential of the account that authorized the GitHub App.
   */
  authorizerCredential?: OAuthCredential;
  /**
   * GitHub App installation id.
   */
  appInstallationId?: string;
};

export type GitHubEnterpriseConfig = {
  /**
   * URI of the GitHub Enterprise host. Immutable — changing it
   * replaces the connection.
   */
  hostUri?: string;
  /**
   * Installation id of the GitHub App.
   */
  appInstallationId?: string;
  /**
   * SSL certificate used for requests to GitHub Enterprise.
   */
  sslCaCertificate?: string;
  /**
   * GitHub Enterprise organization in which the GitHub App is created.
   * Immutable.
   */
  organization?: string;
  /**
   * Secret Manager resource containing the GitHub App private key.
   */
  privateKeySecretVersion?: string;
  /**
   * Id of the GitHub App created from the manifest.
   */
  appId?: string;
  /**
   * Secret Manager resource containing the webhook secret.
   */
  webhookSecretSecretVersion?: string;
  /**
   * Service Directory config for a private GitHub Enterprise host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
};

export type GitLabConfig = {
  /**
   * GitLab personal access token with `api` scope.
   */
  authorizerCredential?: UserCredential;
  /**
   * Secret Manager resource containing the webhook secret. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * GitLab personal access token with `read_api` scope.
   */
  readAuthorizerCredential?: UserCredential;
};

export type GitLabEnterpriseConfig = {
  /**
   * URI of the GitLab Enterprise host. Immutable — changing it
   * replaces the connection.
   */
  hostUri?: string;
  /**
   * Secret Manager resource containing the webhook secret. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * GitLab personal access token with `read_api` scope.
   */
  readAuthorizerCredential?: UserCredential;
  /**
   * GitLab personal access token with `api` scope.
   */
  authorizerCredential?: UserCredential;
  /**
   * Service Directory config for a private GitLab Enterprise host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
  /**
   * SSL certificate used for requests to GitLab Enterprise.
   */
  sslCaCertificate?: string;
};

export type BitbucketCloudConfig = {
  /**
   * Bitbucket Cloud workspace id. Immutable — changing it replaces the
   * connection.
   */
  workspace?: string;
  /**
   * Secret Manager resource containing the webhook secret. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * Access token with `repository` access.
   */
  readAuthorizerCredential?: UserCredential;
  /**
   * Access token with `webhook`, `repository`, and `pullrequest` scope.
   */
  authorizerCredential?: UserCredential;
};

export type BitbucketDataCenterConfig = {
  /**
   * URI of the Bitbucket Data Center host. Immutable — changing it
   * replaces the connection.
   */
  hostUri?: string;
  /**
   * Secret Manager resource containing the webhook secret. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * HTTP access token with `Repository read` access.
   */
  readAuthorizerCredential?: UserCredential;
  /**
   * HTTP access token with `Repository admin` access.
   */
  authorizerCredential?: UserCredential;
  /**
   * Service Directory config for a private Bitbucket Data Center host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
  /**
   * SSL certificate used for requests to Bitbucket Data Center.
   */
  sslCaCertificate?: string;
};

export type SecureSourceManagerInstanceConfig = {
  /**
   * Secure Source Manager instance, as
   * `projects/{project}/locations/{location}/instances/{instance}`.
   * Immutable — changing it replaces the connection.
   */
  instance?: string;
};

export type GitProxyConfig = {
  /**
   * Enable the git proxy for repositories linked on this connection.
   * @default false
   */
  enabled?: boolean;
};

export type CryptoKeyConfig = {
  /**
   * Cloud KMS key used to encrypt customer data, as
   * `projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}`.
   */
  keyReference?: string;
};

export type InstallationState = {
  /** Current step of the installation process. */
  stage?: string;
  /** Message describing the next user action, if any. */
  message?: string;
  /** Link for the next user action, if any. */
  actionUri?: string;
};

export type ConnectionProps = {
  /**
   * Connection id (the `{connection}` segment of
   * `projects/{project}/locations/{location}/connections/{connection}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the connection.
   */
  connectionId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the connection. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * When true, repository APIs and webhook processing for this
   * connection are disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User annotations (AIP-148).
   */
  annotations?: Record<string, string>;
  /**
   * Configuration for github.com. If no SCM config is set, Alchemy
   * defaults to `githubApp: "DEVELOPER_CONNECT"` on create.
   */
  githubConfig?: GitHubConfig;
  /**
   * Configuration for a GitHub Enterprise host. Mutually exclusive
   * with the other SCM configs.
   */
  githubEnterpriseConfig?: GitHubEnterpriseConfig;
  /**
   * Configuration for gitlab.com. Mutually exclusive with the other
   * SCM configs.
   */
  gitlabConfig?: GitLabConfig;
  /**
   * Configuration for GitLab Enterprise. Mutually exclusive with the
   * other SCM configs.
   */
  gitlabEnterpriseConfig?: GitLabEnterpriseConfig;
  /**
   * Configuration for Bitbucket Cloud. Mutually exclusive with the
   * other SCM configs.
   */
  bitbucketCloudConfig?: BitbucketCloudConfig;
  /**
   * Configuration for Bitbucket Data Center. Mutually exclusive with
   * the other SCM configs.
   */
  bitbucketDataCenterConfig?: BitbucketDataCenterConfig;
  /**
   * Configuration for a Secure Source Manager instance. Mutually
   * exclusive with the other SCM configs.
   */
  secureSourceManagerInstanceConfig?: SecureSourceManagerInstanceConfig;
  /**
   * Git proxy configuration.
   */
  gitProxyConfig?: GitProxyConfig;
  /**
   * Customer-managed encryption.
   */
  cryptoKeyConfig?: CryptoKeyConfig;
};

export type Connection = Resource<
  "GCP.DeveloperConnect.Connection",
  ConnectionProps,
  {
    /** Full resource name. */
    name: string;
    /** Connection id (last path segment). */
    connectionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Whether repository APIs and webhooks are disabled. */
    disabled: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** github.com configuration, if this is a GitHub connection. */
    githubConfig: GitHubConfig | undefined;
    /** GitHub Enterprise configuration, if any. */
    githubEnterpriseConfig: GitHubEnterpriseConfig | undefined;
    /** GitLab configuration, if any. */
    gitlabConfig: GitLabConfig | undefined;
    /** GitLab Enterprise configuration, if any. */
    gitlabEnterpriseConfig: GitLabEnterpriseConfig | undefined;
    /** Bitbucket Cloud configuration, if any. */
    bitbucketCloudConfig: BitbucketCloudConfig | undefined;
    /** Bitbucket Data Center configuration, if any. */
    bitbucketDataCenterConfig: BitbucketDataCenterConfig | undefined;
    /** Secure Source Manager configuration, if any. */
    secureSourceManagerInstanceConfig:
      | SecureSourceManagerInstanceConfig
      | undefined;
    /** Git proxy configuration. */
    gitProxyConfig: GitProxyConfig | undefined;
    /** Customer-managed encryption, if any. */
    cryptoKeyConfig: CryptoKeyConfig | undefined;
    /** Installation progress for GitHub-based connections. */
    installationState: InstallationState | undefined;
    /** True while Developer Connect is applying the connection. */
    reconciling: boolean;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Developer Connect connection to a source-control host (GitHub,
 * GitHub Enterprise, GitLab, Bitbucket, or Secure Source Manager).
 *
 * Changing `connectionId`, `location`, SCM kind, `githubApp`, or
 * immutable host fields (`hostUri`, `workspace`,
 * `webhookSecretSecretVersion`, SSM `instance`) replaces the
 * connection. `disabled`, labels, annotations, credentials, and
 * `gitProxyConfig` update in place.
 *
 * ### Creating a Connection
 * **Example:** Generated GitHub connection
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.Connection("Github", {
 *   githubConfig: { githubApp: "DEVELOPER_CONNECT" },
 * });
 * ```
 *
 * **Example:** Named GitHub connection with labels
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.Connection("Github", {
 *   connectionId: "app-github",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   githubConfig: { githubApp: "DEVELOPER_CONNECT" },
 * });
 * ```
 *
 * ### Disabling a Connection
 * **Example:** Disable webhook processing
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.Connection("Github", {
 *   connectionId: "app-github",
 *   githubConfig: { githubApp: "DEVELOPER_CONNECT" },
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category DeveloperConnect
 */
export const Connection = Resource<Connection>(
  "GCP.DeveloperConnect.Connection",
);

type ScmKind =
  | "github"
  | "githubEnterprise"
  | "gitlab"
  | "gitlabEnterprise"
  | "bitbucketCloud"
  | "bitbucketDataCenter"
  | "secureSourceManager";

const resourceName = (
  project: string,
  location: string,
  connectionId: string,
) => `projects/${project}/locations/${location}/connections/${connectionId}`;

const toUserCredential = (
  credential: UserCredential | undefined,
): developerconnect.UserCredential | undefined => {
  if (credential === undefined) return undefined;
  return compact({ userTokenSecretVersion: credential.userTokenSecretVersion });
};

const toOAuthCredential = (
  credential: OAuthCredential | undefined,
): developerconnect.OAuthCredential | undefined => {
  if (credential === undefined) return undefined;
  return compact({
    oauthTokenSecretVersion: credential.oauthTokenSecretVersion,
  });
};

const toServiceDirectory = (
  config: ServiceDirectoryConfig | undefined,
): developerconnect.ServiceDirectoryConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ service: config.service });
};

const toGithub = (
  config: GitHubConfig | undefined,
): developerconnect.GitHubConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    githubApp: config.githubApp ?? "DEVELOPER_CONNECT",
    authorizerCredential: toOAuthCredential(config.authorizerCredential),
    appInstallationId: config.appInstallationId,
  });
};

const toGithubEnterprise = (
  config: GitHubEnterpriseConfig | undefined,
): developerconnect.GitHubEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    appInstallationId: config.appInstallationId,
    sslCaCertificate: config.sslCaCertificate,
    organization: config.organization,
    privateKeySecretVersion: config.privateKeySecretVersion,
    appId: config.appId,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
  });
};

const toGitlab = (
  config: GitLabConfig | undefined,
): developerconnect.GitLabConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    authorizerCredential: toUserCredential(config.authorizerCredential),
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
  });
};

const toGitlabEnterprise = (
  config: GitLabEnterpriseConfig | undefined,
): developerconnect.GitLabEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    sslCaCertificate: config.sslCaCertificate,
  });
};

const toBitbucketCloud = (
  config: BitbucketCloudConfig | undefined,
): developerconnect.BitbucketCloudConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    workspace: config.workspace,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
  });
};

const toBitbucketDataCenter = (
  config: BitbucketDataCenterConfig | undefined,
): developerconnect.BitbucketDataCenterConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    sslCaCertificate: config.sslCaCertificate,
  });
};

const toSsm = (
  config: SecureSourceManagerInstanceConfig | undefined,
): developerconnect.SecureSourceManagerInstanceConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ instance: config.instance });
};

const fromGithub = (
  config: developerconnect.GitHubConfig | undefined,
): GitHubConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    githubApp: config.githubApp,
    authorizerCredential: config.authorizerCredential
      ? compact({
          oauthTokenSecretVersion:
            config.authorizerCredential.oauthTokenSecretVersion,
        })
      : undefined,
    appInstallationId: config.appInstallationId,
  });
};

const fromGithubEnterprise = (
  config: developerconnect.GitHubEnterpriseConfig | undefined,
): GitHubEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    appInstallationId: config.appInstallationId,
    sslCaCertificate: config.sslCaCertificate,
    organization: config.organization,
    privateKeySecretVersion: config.privateKeySecretVersion,
    appId: config.appId,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    serviceDirectoryConfig: config.serviceDirectoryConfig
      ? compact({ service: config.serviceDirectoryConfig.service })
      : undefined,
  });
};

const fromGitlab = (
  config: developerconnect.GitLabConfig | undefined,
): GitLabConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    authorizerCredential: config.authorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.authorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: config.readAuthorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.readAuthorizerCredential.userTokenSecretVersion,
        })
      : undefined,
  });
};

const fromGitlabEnterprise = (
  config: developerconnect.GitLabEnterpriseConfig | undefined,
): GitLabEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: config.readAuthorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.readAuthorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    authorizerCredential: config.authorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.authorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    serviceDirectoryConfig: config.serviceDirectoryConfig
      ? compact({ service: config.serviceDirectoryConfig.service })
      : undefined,
    sslCaCertificate: config.sslCaCertificate,
  });
};

const fromBitbucketCloud = (
  config: developerconnect.BitbucketCloudConfig | undefined,
): BitbucketCloudConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    workspace: config.workspace,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: config.readAuthorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.readAuthorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    authorizerCredential: config.authorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.authorizerCredential.userTokenSecretVersion,
        })
      : undefined,
  });
};

const fromBitbucketDataCenter = (
  config: developerconnect.BitbucketDataCenterConfig | undefined,
): BitbucketDataCenterConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: config.readAuthorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.readAuthorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    authorizerCredential: config.authorizerCredential
      ? compact({
          userTokenSecretVersion:
            config.authorizerCredential.userTokenSecretVersion,
        })
      : undefined,
    serviceDirectoryConfig: config.serviceDirectoryConfig
      ? compact({ service: config.serviceDirectoryConfig.service })
      : undefined,
    sslCaCertificate: config.sslCaCertificate,
  });
};

const fromSsm = (
  config: developerconnect.SecureSourceManagerInstanceConfig | undefined,
): SecureSourceManagerInstanceConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ instance: config.instance });
};

const scmKindOf = (value: {
  githubConfig?: unknown;
  githubEnterpriseConfig?: unknown;
  gitlabConfig?: unknown;
  gitlabEnterpriseConfig?: unknown;
  bitbucketCloudConfig?: unknown;
  bitbucketDataCenterConfig?: unknown;
  secureSourceManagerInstanceConfig?: unknown;
}): ScmKind | undefined => {
  if (value.githubEnterpriseConfig !== undefined) return "githubEnterprise";
  if (value.gitlabEnterpriseConfig !== undefined) return "gitlabEnterprise";
  if (value.gitlabConfig !== undefined) return "gitlab";
  if (value.bitbucketDataCenterConfig !== undefined)
    return "bitbucketDataCenter";
  if (value.bitbucketCloudConfig !== undefined) return "bitbucketCloud";
  if (value.secureSourceManagerInstanceConfig !== undefined)
    return "secureSourceManager";
  if (value.githubConfig !== undefined) return "github";
  return undefined;
};

const desiredScmKind = (news: ConnectionProps): ScmKind | undefined =>
  scmKindOf(news);

const toScmBody = (
  news: ConnectionProps,
): Partial<developerconnect.Connection> => {
  const kind = desiredScmKind(news) ?? "github";
  switch (kind) {
    case "githubEnterprise":
      return {
        githubEnterpriseConfig: toGithubEnterprise(news.githubEnterpriseConfig),
      };
    case "gitlab":
      return { gitlabConfig: toGitlab(news.gitlabConfig) };
    case "gitlabEnterprise":
      return {
        gitlabEnterpriseConfig: toGitlabEnterprise(news.gitlabEnterpriseConfig),
      };
    case "bitbucketCloud":
      return {
        bitbucketCloudConfig: toBitbucketCloud(news.bitbucketCloudConfig),
      };
    case "bitbucketDataCenter":
      return {
        bitbucketDataCenterConfig: toBitbucketDataCenter(
          news.bitbucketDataCenterConfig,
        ),
      };
    case "secureSourceManager":
      return {
        secureSourceManagerInstanceConfig: toSsm(
          news.secureSourceManagerInstanceConfig,
        ),
      };
    default:
      return { githubConfig: toGithub(news.githubConfig ?? {}) };
  }
};

const scmField = (kind: ScmKind | undefined) => {
  switch (kind) {
    case "githubEnterprise":
      return "githubEnterpriseConfig";
    case "gitlab":
      return "gitlabConfig";
    case "gitlabEnterprise":
      return "gitlabEnterpriseConfig";
    case "bitbucketCloud":
      return "bitbucketCloudConfig";
    case "bitbucketDataCenter":
      return "bitbucketDataCenterConfig";
    case "secureSourceManager":
      return "secureSourceManagerInstanceConfig";
    case "github":
      return "githubConfig";
    default:
      return undefined;
  }
};

const immutableHostOf = (value: {
  githubEnterpriseConfig?: { hostUri?: string };
  gitlabEnterpriseConfig?: { hostUri?: string };
  bitbucketDataCenterConfig?: { hostUri?: string };
  bitbucketCloudConfig?: { workspace?: string };
  secureSourceManagerInstanceConfig?: { instance?: string };
  githubConfig?: { githubApp?: string };
}) =>
  value.githubEnterpriseConfig?.hostUri ??
  value.gitlabEnterpriseConfig?.hostUri ??
  value.bitbucketDataCenterConfig?.hostUri ??
  value.bitbucketCloudConfig?.workspace ??
  value.secureSourceManagerInstanceConfig?.instance ??
  value.githubConfig?.githubApp;

const immutableWebhookOf = (value: {
  githubEnterpriseConfig?: { webhookSecretSecretVersion?: string };
  gitlabConfig?: { webhookSecretSecretVersion?: string };
  gitlabEnterpriseConfig?: { webhookSecretSecretVersion?: string };
  bitbucketDataCenterConfig?: { webhookSecretSecretVersion?: string };
  bitbucketCloudConfig?: { webhookSecretSecretVersion?: string };
}) =>
  value.githubEnterpriseConfig?.webhookSecretSecretVersion ??
  value.gitlabConfig?.webhookSecretSecretVersion ??
  value.gitlabEnterpriseConfig?.webhookSecretSecretVersion ??
  value.bitbucketDataCenterConfig?.webhookSecretSecretVersion ??
  value.bitbucketCloudConfig?.webhookSecretSecretVersion;

const toAttrs = (
  item: developerconnect.Connection,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "connections", region);
  return {
    name,
    connectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    disabled: item.disabled === true,
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    githubConfig: fromGithub(item.githubConfig),
    githubEnterpriseConfig: fromGithubEnterprise(item.githubEnterpriseConfig),
    gitlabConfig: fromGitlab(item.gitlabConfig),
    gitlabEnterpriseConfig: fromGitlabEnterprise(item.gitlabEnterpriseConfig),
    bitbucketCloudConfig: fromBitbucketCloud(item.bitbucketCloudConfig),
    bitbucketDataCenterConfig: fromBitbucketDataCenter(
      item.bitbucketDataCenterConfig,
    ),
    secureSourceManagerInstanceConfig: fromSsm(
      item.secureSourceManagerInstanceConfig,
    ),
    gitProxyConfig: item.gitProxyConfig
      ? compact({ enabled: item.gitProxyConfig.enabled === true })
      : undefined,
    cryptoKeyConfig: item.cryptoKeyConfig
      ? compact({ keyReference: item.cryptoKeyConfig.keyReference })
      : undefined,
    installationState: item.installationState
      ? compact({
          stage: item.installationState.stage,
          message: item.installationState.message,
          actionUri: item.installationState.actionUri,
        })
      : undefined,
    reconciling: item.reconciling === true,
    etag: item.etag,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  developerconnect
    .getProjectsLocationsConnections({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      developerconnect.listProjectsLocationsConnections.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.connections,
      (item) => item.labels,
    ),
  );

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "name",
      "connectionId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind =
        desiredScmKind(olds ?? {}) ??
        (output === undefined ? undefined : scmKindOf(output));
      const nextKind = desiredScmKind(news);
      const previousHost =
        immutableHostOf(olds ?? {}) ?? immutableHostOf(output ?? {});
      const nextHost = immutableHostOf(news);
      const previousWebhook =
        immutableWebhookOf(olds ?? {}) ?? immutableWebhookOf(output ?? {});
      const nextWebhook = immutableWebhookOf(news);
      return replaceOnIdentity({
        previousId: olds?.connectionId ?? output?.connectionId,
        nextId: news.connectionId ?? olds?.connectionId ?? output?.connectionId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousKind !== undefined &&
            nextKind !== undefined &&
            nextKind !== previousKind) ||
          (previousHost !== undefined &&
            nextHost !== undefined &&
            nextHost !== previousHost) ||
          (previousWebhook !== undefined &&
            nextWebhook !== undefined &&
            nextWebhook !== previousWebhook),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toPhysicalId(
        id,
        olds?.connectionId,
        output?.connectionId,
        "connection",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toPhysicalId(
        id,
        news.connectionId,
        output?.connectionId,
        "connection",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, connectionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const annotations = news.annotations;
      const desiredDisabled = news.disabled === true;
      const scmBody = toScmBody(news);
      const body = compact({
        ...scmBody,
        disabled: desiredDisabled ? true : undefined,
        labels: desiredLabels,
        annotations,
        gitProxyConfig: news.gitProxyConfig
          ? compact({ enabled: news.gitProxyConfig.enabled })
          : undefined,
        cryptoKeyConfig: news.cryptoKeyConfig
          ? compact({ keyReference: news.cryptoKeyConfig.keyReference })
          : undefined,
      });

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* developerconnect
          .createProjectsLocationsConnections({
            parent: parentOf(env.project, location),
            connectionId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const nextKind = desiredScmKind(news) ?? "github";
      const observedKind = scmKindOf(toAttrs(current, env.project, env.region));
      const observedScm = compact({
        githubConfig: fromGithub(current.githubConfig),
        githubEnterpriseConfig: fromGithubEnterprise(
          current.githubEnterpriseConfig,
        ),
        gitlabConfig: fromGitlab(current.gitlabConfig),
        gitlabEnterpriseConfig: fromGitlabEnterprise(
          current.gitlabEnterpriseConfig,
        ),
        bitbucketCloudConfig: fromBitbucketCloud(current.bitbucketCloudConfig),
        bitbucketDataCenterConfig: fromBitbucketDataCenter(
          current.bitbucketDataCenterConfig,
        ),
        secureSourceManagerInstanceConfig: fromSsm(
          current.secureSourceManagerInstanceConfig,
        ),
      });
      const desiredScm = compact({
        githubConfig:
          nextKind === "github" ? toGithub(news.githubConfig ?? {}) : undefined,
        githubEnterpriseConfig: toGithubEnterprise(news.githubEnterpriseConfig),
        gitlabConfig: toGitlab(news.gitlabConfig),
        gitlabEnterpriseConfig: toGitlabEnterprise(news.gitlabEnterpriseConfig),
        bitbucketCloudConfig: toBitbucketCloud(news.bitbucketCloudConfig),
        bitbucketDataCenterConfig: toBitbucketDataCenter(
          news.bitbucketDataCenterConfig,
        ),
        secureSourceManagerInstanceConfig: toSsm(
          news.secureSourceManagerInstanceConfig,
        ),
      });
      const scmChanged = fingerprint(observedScm) !== fingerprint(desiredScm);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(userAnnotations(annotations)) && "annotations",
        !sameBool(current.disabled, desiredDisabled) && "disabled",
        scmChanged && scmField(nextKind ?? observedKind),
        !sameBool(
          current.gitProxyConfig?.enabled,
          news.gitProxyConfig?.enabled,
        ) && "gitProxyConfig",
        fingerprint(current.cryptoKeyConfig) !==
          fingerprint(news.cryptoKeyConfig) && "cryptoKeyConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* developerconnect
          .patchProjectsLocationsConnections({
            name: current.name ?? name,
            updateMask: mask,
            body: compact({
              etag: current.etag,
              ...body,
              disabled: desiredDisabled,
            }),
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation === undefined) {
          const created = yield* developerconnect
            .createProjectsLocationsConnections({
              parent: parentOf(env.project, location),
              connectionId,
              body,
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
          if (created !== undefined) {
            yield* waitForOperation(created);
          }
        } else {
          yield* waitForOperation(operation);
        }
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* developerconnect
        .deleteProjectsLocationsConnections({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
