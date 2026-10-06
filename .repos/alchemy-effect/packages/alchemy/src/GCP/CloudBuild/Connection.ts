import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

const MAX_NAME_LENGTH = 63;

export type OAuthCredential = {
  /**
   * Secret Manager resource containing the OAuth token that authorizes the
   * Cloud Build GitHub App, as
   * `projects/{project}/secrets/{secret}/versions/{version}`.
   */
  oauthTokenSecretVersion?: string;
};

export type GitHubConfig = {
  /**
   * OAuth credential of the account that authorized the Cloud Build GitHub
   * App. Prefer a robot account. The token must be tied to the Cloud Build
   * GitHub App.
   */
  authorizerCredential?: OAuthCredential;
  /**
   * GitHub App installation id.
   */
  appInstallationId?: string;
};

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

export type GitHubEnterpriseConfig = {
  /**
   * URI of the GitHub Enterprise host. Immutable — changing it replaces
   * the connection.
   */
  hostUri?: string;
  /**
   * API key used to authenticate webhook events.
   */
  apiKey?: string;
  /**
   * Id of the GitHub App created from the manifest.
   */
  appId?: string;
  /**
   * URL-friendly name of the GitHub App.
   */
  appSlug?: string;
  /**
   * Secret Manager resource containing the GitHub App private key, as
   * `projects/{project}/secrets/{secret}/versions/{version}`.
   */
  privateKeySecretVersion?: string;
  /**
   * Secret Manager resource containing the GitHub App webhook secret, as
   * `projects/{project}/secrets/{secret}/versions/{version}`.
   */
  webhookSecretSecretVersion?: string;
  /**
   * Installation id of the GitHub App.
   */
  appInstallationId?: string;
  /**
   * Service Directory config for a private GitHub Enterprise host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
  /**
   * SSL certificate used for requests to GitHub Enterprise.
   */
  sslCa?: string;
};

export type GitLabConfig = {
  /**
   * GitLab host URI. Defaults to `https://gitlab.com`. Immutable —
   * changing it replaces the connection.
   */
  hostUri?: string;
  /**
   * Secret Manager resource containing the webhook secret, as
   * `projects/{project}/secrets/{secret}/versions/{version}`. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * GitLab personal access token with at least `read_api` scope.
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
  sslCa?: string;
};

export type BitbucketDataCenterConfig = {
  /**
   * URI of the Bitbucket Data Center instance. Immutable — changing it
   * replaces the connection.
   */
  hostUri?: string;
  /**
   * Secret Manager resource containing the webhook secret, as
   * `projects/{project}/secrets/{secret}/versions/{version}`. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * HTTP access token with `REPO_READ` access.
   */
  readAuthorizerCredential?: UserCredential;
  /**
   * HTTP access token with `REPO_ADMIN` access.
   */
  authorizerCredential?: UserCredential;
  /**
   * Service Directory config for a private Bitbucket Data Center host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
  /**
   * SSL certificate used for requests to Bitbucket Data Center.
   */
  sslCa?: string;
};

export type BitbucketCloudConfig = {
  /**
   * Bitbucket Cloud workspace id. Immutable — changing it replaces the
   * connection.
   */
  workspace?: string;
  /**
   * Secret Manager resource containing the webhook secret, as
   * `projects/{project}/secrets/{secret}/versions/{version}`. Immutable —
   * changing it replaces the connection.
   */
  webhookSecretSecretVersion?: string;
  /**
   * Access token with `repository` access.
   */
  readAuthorizerCredential?: UserCredential;
  /**
   * Access token with `webhook`, `repository`, `repository:admin`, and
   * `pullrequest` scope.
   */
  authorizerCredential?: UserCredential;
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
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be unique per project and location. Immutable —
   * changing it replaces the connection.
   */
  connectionId?: string;
  /**
   * Cloud Build location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the connection. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * When true, repository APIs and webhook processing for this connection
   * are disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * User annotations. Cloud Build connections have no labels, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * here for `list` / nuke.
   */
  annotations?: Record<string, string>;
  /**
   * Configuration for github.com. If no SCM config is set, Alchemy
   * defaults to an empty GitHub config on create (installation stays
   * pending until the Cloud Build GitHub App is authorized).
   */
  githubConfig?: GitHubConfig;
  /**
   * Configuration for a GitHub Enterprise host. Mutually exclusive with
   * the other SCM configs. Changing `hostUri` replaces the connection.
   */
  githubEnterpriseConfig?: GitHubEnterpriseConfig;
  /**
   * Configuration for gitlab.com or GitLab Enterprise. Mutually exclusive
   * with the other SCM configs. Changing `hostUri` or
   * `webhookSecretSecretVersion` replaces the connection.
   */
  gitlabConfig?: GitLabConfig;
  /**
   * Configuration for Bitbucket Data Center. Mutually exclusive with the
   * other SCM configs. Changing `hostUri` or
   * `webhookSecretSecretVersion` replaces the connection.
   */
  bitbucketDataCenterConfig?: BitbucketDataCenterConfig;
  /**
   * Configuration for Bitbucket Cloud. Mutually exclusive with the other
   * SCM configs. Changing `workspace` or `webhookSecretSecretVersion`
   * replaces the connection.
   */
  bitbucketCloudConfig?: BitbucketCloudConfig;
};

export type Connection = Resource<
  "GCP.CloudBuild.Connection",
  ConnectionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/connections/{connection}`. */
    name: string;
    /** Connection id (last path segment). */
    connectionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Whether repository APIs and webhooks are disabled. */
    disabled: boolean;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** github.com configuration, if this is a GitHub connection. */
    githubConfig: GitHubConfig | undefined;
    /** GitHub Enterprise configuration, if any. */
    githubEnterpriseConfig: GitHubEnterpriseConfig | undefined;
    /** GitLab configuration, if any. */
    gitlabConfig: GitLabConfig | undefined;
    /** Bitbucket Data Center configuration, if any. */
    bitbucketDataCenterConfig: BitbucketDataCenterConfig | undefined;
    /** Bitbucket Cloud configuration, if any. */
    bitbucketCloudConfig: BitbucketCloudConfig | undefined;
    /** Installation progress for GitHub-based connections. */
    installationState: InstallationState | undefined;
    /** True while Cloud Build is applying the connection in the background. */
    reconciling: boolean;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Build v2 connection to a source-control host (GitHub, GitHub
 * Enterprise, GitLab, Bitbucket Data Center, or Bitbucket Cloud).
 *
 * Changing `connectionId` or `location` replaces the connection. Switching
 * SCM kinds, or changing immutable host fields (`hostUri`, `workspace`,
 * `webhookSecretSecretVersion`), also replaces. `disabled` and
 * `annotations` update in place.
 *
 * Cloud Build connections have no labels. Alchemy stores ownership in
 * annotations (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) so
 * `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a Connection
 * **Example:** Generated GitHub connection
 * ```typescript
 * const github = yield* GCP.CloudBuild.Connection("Github", {
 *   githubConfig: {},
 * });
 * ```
 *
 * **Example:** Named GitHub connection with installation
 * ```typescript
 * const github = yield* GCP.CloudBuild.Connection("Github", {
 *   connectionId: "app-github",
 *   location: "us-central1",
 *   annotations: { env: "prod" },
 *   githubConfig: {
 *     appInstallationId: "123456",
 *     authorizerCredential: {
 *       oauthTokenSecretVersion:
 *         "projects/{project}/secrets/github-pat/versions/latest",
 *     },
 *   },
 * });
 * ```
 *
 * ### Disabling a Connection
 * **Example:** Disable webhook processing
 * ```typescript
 * const github = yield* GCP.CloudBuild.Connection("Github", {
 *   connectionId: "app-github",
 *   githubConfig: {},
 *   disabled: true,
 * });
 * ```
 *
 * ### GitLab
 * **Example:** GitLab.com connection
 * ```typescript
 * const gitlab = yield* GCP.CloudBuild.Connection("Gitlab", {
 *   gitlabConfig: {
 *     webhookSecretSecretVersion:
 *       "projects/{project}/secrets/gitlab-webhook/versions/latest",
 *     readAuthorizerCredential: {
 *       userTokenSecretVersion:
 *         "projects/{project}/secrets/gitlab-read/versions/latest",
 *     },
 *     authorizerCredential: {
 *       userTokenSecretVersion:
 *         "projects/{project}/secrets/gitlab-api/versions/latest",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category CloudBuild
 */
export const Connection = Resource<Connection>("GCP.CloudBuild.Connection");

export class ConnectionNotResolved extends Data.TaggedError(
  "GCP.CloudBuild.ConnectionNotResolved",
)<{
  name: string;
}> {}

export class ConnectionStillExists extends Data.TaggedError(
  "GCP.CloudBuild.ConnectionStillExists",
)<{
  name: string;
}> {}

type ScmKind =
  | "github"
  | "githubEnterprise"
  | "gitlab"
  | "bitbucketDataCenter"
  | "bitbucketCloud";

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const resourceName = (
  project: string,
  location: string,
  connectionId: string,
) => `projects/${project}/locations/${location}/connections/${connectionId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const connectionsAt = parts.lastIndexOf("connections");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    connectionId:
      connectionsAt >= 0 && parts[connectionsAt + 1]
        ? parts[connectionsAt + 1]!
        : lastSegment(name),
  };
};

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const toId = (
  id: string,
  connectionId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      connectionId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const toOAuthCredential = (
  credential: OAuthCredential | undefined,
): cloudbuild.OAuthCredential | undefined => {
  if (credential === undefined) return undefined;
  return compact({
    oauthTokenSecretVersion: credential.oauthTokenSecretVersion,
  });
};

const toUserCredential = (
  credential: UserCredential | undefined,
): cloudbuild.UserCredential | undefined => {
  if (credential === undefined) return undefined;
  return compact({
    userTokenSecretVersion: credential.userTokenSecretVersion,
  });
};

const toServiceDirectory = (
  config: ServiceDirectoryConfig | undefined,
): cloudbuild.GoogleDevtoolsCloudbuildV2ServiceDirectoryConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ service: config.service });
};

const toGithub = (
  config: GitHubConfig | undefined,
): cloudbuild.GitHubConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    authorizerCredential: toOAuthCredential(config.authorizerCredential),
    appInstallationId: config.appInstallationId,
  });
};

const toGithubEnterprise = (
  config: GitHubEnterpriseConfig | undefined,
): cloudbuild.GoogleDevtoolsCloudbuildV2GitHubEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    apiKey: config.apiKey,
    appId: config.appId,
    appSlug: config.appSlug,
    privateKeySecretVersion: config.privateKeySecretVersion,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    appInstallationId: config.appInstallationId,
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    sslCa: config.sslCa,
  });
};

const toGitlab = (
  config: GitLabConfig | undefined,
): cloudbuild.GoogleDevtoolsCloudbuildV2GitLabConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    sslCa: config.sslCa,
  });
};

const toBitbucketDataCenter = (
  config: BitbucketDataCenterConfig | undefined,
): cloudbuild.BitbucketDataCenterConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    sslCa: config.sslCa,
  });
};

const toBitbucketCloud = (
  config: BitbucketCloudConfig | undefined,
): cloudbuild.BitbucketCloudConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    workspace: config.workspace,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    readAuthorizerCredential: toUserCredential(config.readAuthorizerCredential),
    authorizerCredential: toUserCredential(config.authorizerCredential),
  });
};

const fromGithub = (
  config: cloudbuild.GitHubConfig | undefined,
): GitHubConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
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
  config:
    | cloudbuild.GoogleDevtoolsCloudbuildV2GitHubEnterpriseConfig
    | undefined,
): GitHubEnterpriseConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    hostUri: config.hostUri,
    apiKey: config.apiKey,
    appId: config.appId,
    appSlug: config.appSlug,
    privateKeySecretVersion: config.privateKeySecretVersion,
    webhookSecretSecretVersion: config.webhookSecretSecretVersion,
    appInstallationId: config.appInstallationId,
    serviceDirectoryConfig: config.serviceDirectoryConfig
      ? compact({ service: config.serviceDirectoryConfig.service })
      : undefined,
    sslCa: config.sslCa,
  });
};

const fromGitlab = (
  config: cloudbuild.GoogleDevtoolsCloudbuildV2GitLabConfig | undefined,
): GitLabConfig | undefined => {
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
    sslCa: config.sslCa,
  });
};

const fromBitbucketDataCenter = (
  config: cloudbuild.BitbucketDataCenterConfig | undefined,
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
    sslCa: config.sslCa,
  });
};

const fromBitbucketCloud = (
  config: cloudbuild.BitbucketCloudConfig | undefined,
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

const fromInstallationState = (
  state: cloudbuild.InstallationState | undefined,
): InstallationState | undefined => {
  if (state === undefined) return undefined;
  return compact({
    stage: state.stage,
    message: state.message,
    actionUri: state.actionUri,
  });
};

const scmKindOf = (value: {
  githubConfig?: unknown;
  githubEnterpriseConfig?: unknown;
  gitlabConfig?: unknown;
  bitbucketDataCenterConfig?: unknown;
  bitbucketCloudConfig?: unknown;
}): ScmKind | undefined => {
  if (value.githubEnterpriseConfig !== undefined) return "githubEnterprise";
  if (value.gitlabConfig !== undefined) return "gitlab";
  if (value.bitbucketDataCenterConfig !== undefined)
    return "bitbucketDataCenter";
  if (value.bitbucketCloudConfig !== undefined) return "bitbucketCloud";
  if (value.githubConfig !== undefined) return "github";
  return undefined;
};

const observedScmKind = (
  connection: cloudbuild.Connection,
): ScmKind | undefined => {
  if (connection.githubEnterpriseConfig !== undefined)
    return "githubEnterprise";
  if (connection.gitlabConfig !== undefined) return "gitlab";
  if (connection.bitbucketDataCenterConfig !== undefined)
    return "bitbucketDataCenter";
  if (connection.bitbucketCloudConfig !== undefined) return "bitbucketCloud";
  if (connection.githubConfig !== undefined) return "github";
  return undefined;
};

const desiredScmKind = (news: ConnectionProps): ScmKind | undefined =>
  scmKindOf(news);

const toScmBody = (news: ConnectionProps): Partial<cloudbuild.Connection> => {
  const kind = desiredScmKind(news) ?? "github";
  switch (kind) {
    case "githubEnterprise":
      return {
        githubEnterpriseConfig: toGithubEnterprise(news.githubEnterpriseConfig),
      };
    case "gitlab":
      return { gitlabConfig: toGitlab(news.gitlabConfig) };
    case "bitbucketDataCenter":
      return {
        bitbucketDataCenterConfig: toBitbucketDataCenter(
          news.bitbucketDataCenterConfig,
        ),
      };
    case "bitbucketCloud":
      return {
        bitbucketCloudConfig: toBitbucketCloud(news.bitbucketCloudConfig),
      };
    default:
      return { githubConfig: toGithub(news.githubConfig ?? {}) };
  }
};

const fieldChanged = (
  desired: string | undefined,
  observed: string | undefined,
) => desired !== undefined && (desired ?? "") !== (observed ?? "");

const githubChanged = (
  desired: GitHubConfig | undefined,
  observed: GitHubConfig | undefined,
) => {
  if (desired === undefined) return false;
  return (
    fieldChanged(desired.appInstallationId, observed?.appInstallationId) ||
    fieldChanged(
      desired.authorizerCredential?.oauthTokenSecretVersion,
      observed?.authorizerCredential?.oauthTokenSecretVersion,
    )
  );
};

const githubEnterpriseChanged = (
  desired: GitHubEnterpriseConfig | undefined,
  observed: GitHubEnterpriseConfig | undefined,
) => {
  if (desired === undefined) return false;
  return (
    fieldChanged(desired.hostUri, observed?.hostUri) ||
    fieldChanged(desired.apiKey, observed?.apiKey) ||
    fieldChanged(desired.appId, observed?.appId) ||
    fieldChanged(desired.appSlug, observed?.appSlug) ||
    fieldChanged(
      desired.privateKeySecretVersion,
      observed?.privateKeySecretVersion,
    ) ||
    fieldChanged(
      desired.webhookSecretSecretVersion,
      observed?.webhookSecretSecretVersion,
    ) ||
    fieldChanged(desired.appInstallationId, observed?.appInstallationId) ||
    fieldChanged(
      desired.serviceDirectoryConfig?.service,
      observed?.serviceDirectoryConfig?.service,
    ) ||
    fieldChanged(desired.sslCa, observed?.sslCa)
  );
};

const gitlabChanged = (
  desired: GitLabConfig | undefined,
  observed: GitLabConfig | undefined,
) => {
  if (desired === undefined) return false;
  return (
    fieldChanged(desired.hostUri, observed?.hostUri) ||
    fieldChanged(
      desired.webhookSecretSecretVersion,
      observed?.webhookSecretSecretVersion,
    ) ||
    fieldChanged(
      desired.readAuthorizerCredential?.userTokenSecretVersion,
      observed?.readAuthorizerCredential?.userTokenSecretVersion,
    ) ||
    fieldChanged(
      desired.authorizerCredential?.userTokenSecretVersion,
      observed?.authorizerCredential?.userTokenSecretVersion,
    ) ||
    fieldChanged(
      desired.serviceDirectoryConfig?.service,
      observed?.serviceDirectoryConfig?.service,
    ) ||
    fieldChanged(desired.sslCa, observed?.sslCa)
  );
};

const bitbucketDataCenterChanged = (
  desired: BitbucketDataCenterConfig | undefined,
  observed: BitbucketDataCenterConfig | undefined,
) => {
  if (desired === undefined) return false;
  return (
    fieldChanged(desired.hostUri, observed?.hostUri) ||
    fieldChanged(
      desired.webhookSecretSecretVersion,
      observed?.webhookSecretSecretVersion,
    ) ||
    fieldChanged(
      desired.readAuthorizerCredential?.userTokenSecretVersion,
      observed?.readAuthorizerCredential?.userTokenSecretVersion,
    ) ||
    fieldChanged(
      desired.authorizerCredential?.userTokenSecretVersion,
      observed?.authorizerCredential?.userTokenSecretVersion,
    ) ||
    fieldChanged(
      desired.serviceDirectoryConfig?.service,
      observed?.serviceDirectoryConfig?.service,
    ) ||
    fieldChanged(desired.sslCa, observed?.sslCa)
  );
};

const bitbucketCloudChanged = (
  desired: BitbucketCloudConfig | undefined,
  observed: BitbucketCloudConfig | undefined,
) => {
  if (desired === undefined) return false;
  return (
    fieldChanged(desired.workspace, observed?.workspace) ||
    fieldChanged(
      desired.webhookSecretSecretVersion,
      observed?.webhookSecretSecretVersion,
    ) ||
    fieldChanged(
      desired.readAuthorizerCredential?.userTokenSecretVersion,
      observed?.readAuthorizerCredential?.userTokenSecretVersion,
    ) ||
    fieldChanged(
      desired.authorizerCredential?.userTokenSecretVersion,
      observed?.authorizerCredential?.userTokenSecretVersion,
    )
  );
};

const immutableHostOf = (value: {
  githubEnterpriseConfig?: { hostUri?: string };
  gitlabConfig?: { hostUri?: string };
  bitbucketDataCenterConfig?: { hostUri?: string };
  bitbucketCloudConfig?: { workspace?: string };
}) =>
  value.githubEnterpriseConfig?.hostUri ??
  value.gitlabConfig?.hostUri ??
  value.bitbucketDataCenterConfig?.hostUri ??
  value.bitbucketCloudConfig?.workspace;

const immutableWebhookOf = (value: {
  githubEnterpriseConfig?: { webhookSecretSecretVersion?: string };
  gitlabConfig?: { webhookSecretSecretVersion?: string };
  bitbucketDataCenterConfig?: { webhookSecretSecretVersion?: string };
  bitbucketCloudConfig?: { webhookSecretSecretVersion?: string };
}) =>
  value.githubEnterpriseConfig?.webhookSecretSecretVersion ??
  value.gitlabConfig?.webhookSecretSecretVersion ??
  value.bitbucketDataCenterConfig?.webhookSecretSecretVersion ??
  value.bitbucketCloudConfig?.webhookSecretSecretVersion;

const toAttrs = (connection: cloudbuild.Connection, project: string) => {
  const name = connection.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    connectionId: parsed.connectionId,
    project: parsed.project || project,
    location: parsed.location,
    disabled: connection.disabled === true,
    annotations: userAnnotations(connection.annotations),
    githubConfig: fromGithub(connection.githubConfig),
    githubEnterpriseConfig: fromGithubEnterprise(
      connection.githubEnterpriseConfig,
    ),
    gitlabConfig: fromGitlab(connection.gitlabConfig),
    bitbucketDataCenterConfig: fromBitbucketDataCenter(
      connection.bitbucketDataCenterConfig,
    ),
    bitbucketCloudConfig: fromBitbucketCloud(connection.bitbucketCloudConfig),
    installationState: fromInstallationState(connection.installationState),
    reconciling: connection.reconciling === true,
    etag: connection.etag,
    createTime: connection.createTime,
    updateTime: connection.updateTime,
  };
};

const getByName = (name: string) =>
  cloudbuild
    .getProjectsLocationsConnections({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait on a Cloud Build connections long-running operation (seconds to a minute).
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
const waitForOperation = (
  operation: cloudbuild.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = cloudbuild.getProjectsLocationsOperations({ name }).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              latest = current;
            }),
          ),
        );
        const observe: Effect.Effect<
          cloudbuild.Operation,
          cloudbuild.GetProjectsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<cloudbuild.Operation>({ name, done: true }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "5 minutes" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((connection) =>
      connection
        ? Effect.succeed(connection)
        : Effect.fail(new ConnectionNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudBuild.ConnectionNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((connection) =>
      connection === undefined
        ? Effect.void
        : Effect.fail(new ConnectionStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudBuild.ConnectionStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: ["name", "connectionId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.connectionId ?? output?.connectionId;
      const nextId = news.connectionId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      const previousKind =
        desiredScmKind(olds ?? {}) ??
        (output === undefined ? undefined : scmKindOf(output));
      const nextKind = desiredScmKind(news);
      const kindChanged =
        previousKind !== undefined &&
        nextKind !== undefined &&
        nextKind !== previousKind;

      const previousHost =
        immutableHostOf(olds ?? {}) ?? immutableHostOf(output ?? {});
      const nextHost = immutableHostOf(news);
      const hostChanged =
        previousHost !== undefined &&
        nextHost !== undefined &&
        nextHost !== previousHost;

      const previousWebhook =
        immutableWebhookOf(olds ?? {}) ?? immutableWebhookOf(output ?? {});
      const nextWebhook = immutableWebhookOf(news);
      const webhookChanged =
        previousWebhook !== undefined &&
        nextWebhook !== undefined &&
        nextWebhook !== previousWebhook;

      if (
        idChanged ||
        locationChanged ||
        kindChanged ||
        hostChanged ||
        webhookChanged
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toId(
        id,
        olds?.connectionId,
        output?.connectionId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* cloudbuild.listProjectsLocationsConnections
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.connections ?? []),
            ),
            Stream.filter((connection) =>
              Object.keys(connection.annotations ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((connection) => toAttrs(connection, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectionId = yield* toId(
        id,
        news.connectionId,
        output?.connectionId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, connectionId);
      const parent = parentOf(env.project, location);
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };
      const desiredDisabled = news.disabled === true;
      const scmBody = toScmBody(news);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* cloudbuild
          .createProjectsLocationsConnections({
            parent,
            connectionId,
            body: compact({
              ...scmBody,
              disabled: desiredDisabled ? true : undefined,
              annotations: desiredAnnotations,
            }),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({ name });
      }

      const observedAnnotations = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(
        observedAnnotations,
        desiredAnnotations,
      );
      const annotationsChanged = upsert.length > 0 || removed.length > 0;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;
      const observedKind = observedScmKind(current);
      const nextKind = desiredScmKind(news);
      const githubConfigChanged =
        nextKind === "github" &&
        githubChanged(news.githubConfig, fromGithub(current.githubConfig));
      const githubEnterpriseConfigChanged =
        nextKind === "githubEnterprise" &&
        githubEnterpriseChanged(
          news.githubEnterpriseConfig,
          fromGithubEnterprise(current.githubEnterpriseConfig),
        );
      const gitlabConfigChanged =
        nextKind === "gitlab" &&
        gitlabChanged(news.gitlabConfig, fromGitlab(current.gitlabConfig));
      const bitbucketDataCenterConfigChanged =
        nextKind === "bitbucketDataCenter" &&
        bitbucketDataCenterChanged(
          news.bitbucketDataCenterConfig,
          fromBitbucketDataCenter(current.bitbucketDataCenterConfig),
        );
      const bitbucketCloudConfigChanged =
        nextKind === "bitbucketCloud" &&
        bitbucketCloudChanged(
          news.bitbucketCloudConfig,
          fromBitbucketCloud(current.bitbucketCloudConfig),
        );
      const scmChanged =
        (nextKind !== undefined &&
          observedKind !== undefined &&
          nextKind !== observedKind) ||
        githubConfigChanged ||
        githubEnterpriseConfigChanged ||
        gitlabConfigChanged ||
        bitbucketDataCenterConfigChanged ||
        bitbucketCloudConfigChanged;

      const updateMask = [
        annotationsChanged ? "annotations" : undefined,
        disabledChanged ? "disabled" : undefined,
        scmChanged && (nextKind ?? observedKind) === "github"
          ? "githubConfig"
          : undefined,
        scmChanged && (nextKind ?? observedKind) === "githubEnterprise"
          ? "githubEnterpriseConfig"
          : undefined,
        scmChanged && (nextKind ?? observedKind) === "gitlab"
          ? "gitlabConfig"
          : undefined,
        scmChanged && (nextKind ?? observedKind) === "bitbucketDataCenter"
          ? "bitbucketDataCenterConfig"
          : undefined,
        scmChanged && (nextKind ?? observedKind) === "bitbucketCloud"
          ? "bitbucketCloudConfig"
          : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const body = compact({
          ...(scmChanged ? scmBody : {}),
          disabled: desiredDisabled,
          annotations: desiredAnnotations,
        });
        const operation = yield* cloudbuild
          .patchProjectsLocationsConnections({
            name,
            updateMask: updateMask.join(","),
            body,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation === undefined) {
          const created = yield* cloudbuild
            .createProjectsLocationsConnections({
              parent,
              connectionId,
              body: compact({
                ...scmBody,
                disabled: desiredDisabled ? true : undefined,
                annotations: desiredAnnotations,
              }),
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
          if (created !== undefined) {
            yield* waitForOperation(created);
          }
        } else {
          yield* waitForOperation(operation);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* cloudbuild
        .deleteProjectsLocationsConnections({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
