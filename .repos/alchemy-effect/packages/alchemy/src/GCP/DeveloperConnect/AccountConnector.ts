import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import type { ServiceDirectoryConfig } from "./Connection.ts";
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

export type CustomOAuthConfig = {
  /**
   * Client secret of the OAuth application. Input only — not returned
   * on read.
   */
  clientSecret?: string;
  /**
   * Service Directory config for a private OAuth host.
   */
  serviceDirectoryConfig?: ServiceDirectoryConfig;
  /**
   * SCM provider (`GITHUB_ENTERPRISE`, `GITLAB_ENTERPRISE`,
   * `BITBUCKET_DATA_CENTER`). Immutable — changing it replaces the
   * connector.
   */
  scmProvider?:
    | developerconnect.CustomOAuthConfigScmProviderEnum
    | (string & {});
  /**
   * Host URI of the OAuth application. Immutable — changing it
   * replaces the connector.
   */
  hostUri?: string;
  /**
   * OAuth client id.
   */
  clientId?: string;
  /**
   * SSL certificate used for requests to a private host.
   */
  sslCaCertificate?: string;
  /**
   * OAuth2 token request URL. Immutable — changing it replaces the
   * connector.
   */
  tokenUri?: string;
  /**
   * Disable PKCE for this OAuth config. PKCE is enabled by default.
   */
  pkceDisabled?: boolean;
  /**
   * OAuth2 authorization server URL. Immutable — changing it replaces
   * the connector.
   */
  authUri?: string;
  /**
   * Scopes requested during OAuth.
   */
  scopes?: string[];
};

export type ProviderOAuthConfig = {
  /**
   * Developer Connect provided OAuth system
   * (`GITHUB`, `GITLAB`, `GOOGLE`, `SENTRY`, `ROVO`, `NEW_RELIC`,
   * `DATASTAX`, `DYNATRACE`). Immutable — changing it replaces the
   * connector.
   */
  systemProviderId?:
    | developerconnect.ProviderOAuthConfigSystemProviderIdEnum
    | (string & {});
  /**
   * User-selected OAuth scopes. Changing scopes deletes existing user
   * records under the connector so users re-auth.
   */
  scopes?: string[];
};

export type ProxyConfig = {
  /**
   * Allow the git and HTTP proxies to act on behalf of users configured
   * under this connector.
   * @default false
   */
  enabled?: boolean;
};

export type AccountConnectorProps = {
  /**
   * Account connector id (the `{accountConnector}` segment of
   * `projects/{project}/locations/{location}/accountConnectors/{accountConnector}`).
   * If omitted, a unique RFC1035 name is generated from the stack,
   * stage, and logical id. Immutable — changing it replaces the
   * connector.
   */
  accountConnectorId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the connector. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Developer Connect provided OAuth. Mutually exclusive with
   * `customOauthConfig`.
   */
  providerOauthConfig?: ProviderOAuthConfig;
  /**
   * Custom OAuth application. Mutually exclusive with
   * `providerOauthConfig`. Changing immutable host fields replaces the
   * connector.
   */
  customOauthConfig?: CustomOAuthConfig;
  /**
   * Git and HTTP proxy configuration.
   */
  proxyConfig?: ProxyConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User annotations (AIP-148).
   */
  annotations?: Record<string, string>;
};

export type AccountConnector = Resource<
  "GCP.DeveloperConnect.AccountConnector",
  AccountConnectorProps,
  {
    /** Full resource name. */
    name: string;
    /** Account connector id (last path segment). */
    accountConnectorId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Developer Connect provided OAuth config, if any. */
    providerOauthConfig: ProviderOAuthConfig | undefined;
    /** Custom OAuth config, if any (secrets stripped). */
    customOauthConfig: CustomOAuthConfig | undefined;
    /** Proxy configuration. */
    proxyConfig: ProxyConfig | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** URL that starts the OAuth flow. */
    oauthStartUri: string | undefined;
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
 * A Developer Connect account connector — the OAuth configuration that
 * lets users connect their SCM accounts (GitHub, GitLab, Google, …) to
 * Google Cloud.
 *
 * Changing `accountConnectorId`, `location`, `systemProviderId`, or
 * immutable custom-OAuth host fields (`hostUri`, `tokenUri`, `authUri`,
 * `scmProvider`) replaces the connector. Labels, annotations, scopes,
 * and `proxyConfig` update in place.
 *
 * ### Creating an Account Connector
 * **Example:** GitHub system provider
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.AccountConnector("Github", {
 *   providerOauthConfig: {
 *     systemProviderId: "GITHUB",
 *     scopes: ["repo"],
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and proxy
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.AccountConnector("Github", {
 *   accountConnectorId: "app-github",
 *   location: "us-central1",
 *   providerOauthConfig: {
 *     systemProviderId: "GITHUB",
 *     scopes: ["repo", "read:user"],
 *   },
 *   proxyConfig: { enabled: true },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Account Connector
 * **Example:** Labels and proxy
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const github = yield* GCP.DeveloperConnect.AccountConnector("Github", {
 *   accountConnectorId: "app-github",
 *   providerOauthConfig: {
 *     systemProviderId: "GITHUB",
 *     scopes: ["repo"],
 *   },
 *   labels: { env: "prod", team: "platform" },
 *   proxyConfig: { enabled: true },
 * });
 * ```
 *
 * @resource
 * @category DeveloperConnect
 */
export const AccountConnector = Resource<AccountConnector>(
  "GCP.DeveloperConnect.AccountConnector",
);

const resourceName = (
  project: string,
  location: string,
  accountConnectorId: string,
) =>
  `projects/${project}/locations/${location}/accountConnectors/${accountConnectorId}`;

const toServiceDirectory = (
  config: ServiceDirectoryConfig | undefined,
): developerconnect.ServiceDirectoryConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ service: config.service });
};

const toCustomOauth = (
  config: CustomOAuthConfig | undefined,
): developerconnect.CustomOAuthConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    clientSecret: config.clientSecret,
    serviceDirectoryConfig: toServiceDirectory(config.serviceDirectoryConfig),
    scmProvider: config.scmProvider,
    hostUri: config.hostUri,
    clientId: config.clientId,
    sslCaCertificate: config.sslCaCertificate,
    tokenUri: config.tokenUri,
    pkceDisabled: config.pkceDisabled,
    authUri: config.authUri,
    scopes: config.scopes,
  });
};

const toProviderOauth = (
  config: ProviderOAuthConfig | undefined,
): developerconnect.ProviderOAuthConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    systemProviderId: config.systemProviderId,
    scopes: config.scopes,
  });
};

const toProxy = (
  config: ProxyConfig | undefined,
): developerconnect.ProxyConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ enabled: config.enabled });
};

const fromCustomOauth = (
  config: developerconnect.CustomOAuthConfig | undefined,
): CustomOAuthConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    serviceDirectoryConfig: config.serviceDirectoryConfig
      ? compact({ service: config.serviceDirectoryConfig.service })
      : undefined,
    scmProvider: config.scmProvider,
    hostUri: config.hostUri,
    clientId: config.clientId,
    sslCaCertificate: config.sslCaCertificate,
    tokenUri: config.tokenUri,
    pkceDisabled: config.pkceDisabled,
    authUri: config.authUri,
    scopes: config.scopes,
  });
};

const fromProviderOauth = (
  config: developerconnect.ProviderOAuthConfig | undefined,
): ProviderOAuthConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({
    systemProviderId: config.systemProviderId,
    scopes: config.scopes,
  });
};

const fromProxy = (
  config: developerconnect.ProxyConfig | undefined,
): ProxyConfig | undefined => {
  if (config === undefined) return undefined;
  return compact({ enabled: config.enabled === true });
};

const toAttrs = (
  item: developerconnect.AccountConnector,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "accountConnectors", region);
  return {
    name,
    accountConnectorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    providerOauthConfig: fromProviderOauth(item.providerOauthConfig),
    customOauthConfig: fromCustomOauth(item.customOauthConfig),
    proxyConfig: fromProxy(item.proxyConfig),
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    oauthStartUri: item.oauthStartUri,
    etag: item.etag,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  developerconnect
    .getProjectsLocationsAccountConnectors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      developerconnect.listProjectsLocationsAccountConnectors.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.accountConnectors,
      (item) => item.labels,
    ),
  );

const immutableCustomKey = (config: CustomOAuthConfig | undefined) =>
  fingerprint({
    scmProvider: config?.scmProvider,
    hostUri: config?.hostUri,
    tokenUri: config?.tokenUri,
    authUri: config?.authUri,
  });

export const AccountConnectorProvider = () =>
  Provider.succeed(AccountConnector, {
    stables: [
      "name",
      "accountConnectorId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProvider =
        olds?.providerOauthConfig?.systemProviderId ??
        output?.providerOauthConfig?.systemProviderId;
      const nextProvider = news.providerOauthConfig?.systemProviderId;
      const previousCustom =
        immutableCustomKey(olds?.customOauthConfig) ??
        immutableCustomKey(output?.customOauthConfig);
      const nextCustom = immutableCustomKey(news.customOauthConfig);
      return replaceOnIdentity({
        previousId: olds?.accountConnectorId ?? output?.accountConnectorId,
        nextId:
          news.accountConnectorId ??
          olds?.accountConnectorId ??
          output?.accountConnectorId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousProvider !== undefined &&
            nextProvider !== undefined &&
            previousProvider !== nextProvider) ||
          (previousCustom !== fingerprint(undefined) &&
            nextCustom !== fingerprint(undefined) &&
            previousCustom !== nextCustom),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const accountConnectorId = yield* toPhysicalId(
        id,
        olds?.accountConnectorId,
        output?.accountConnectorId,
        "accountconnector",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, accountConnectorId);
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
      const accountConnectorId = yield* toPhysicalId(
        id,
        news.accountConnectorId,
        output?.accountConnectorId,
        "accountconnector",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, accountConnectorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const annotations = news.annotations;
      const body = compact({
        providerOauthConfig: toProviderOauth(news.providerOauthConfig),
        customOauthConfig: toCustomOauth(news.customOauthConfig),
        proxyConfig: toProxy(news.proxyConfig),
        labels: desiredLabels,
        annotations,
      });

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* developerconnect
          .createProjectsLocationsAccountConnectors({
            parent: parentOf(env.project, location),
            accountConnectorId,
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
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(userAnnotations(annotations)) && "annotations",
        fingerprint(fromProviderOauth(current.providerOauthConfig)) !==
          fingerprint(news.providerOauthConfig) && "providerOauthConfig",
        fingerprint(fromCustomOauth(current.customOauthConfig)) !==
          fingerprint({
            ...news.customOauthConfig,
            clientSecret: undefined,
          }) && "customOauthConfig",
        !sameBool(current.proxyConfig?.enabled, news.proxyConfig?.enabled) &&
          "proxyConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* developerconnect
          .patchProjectsLocationsAccountConnectors({
            name: current.name ?? name,
            updateMask: mask,
            body: compact({
              etag: current.etag,
              ...body,
            }),
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation === undefined) {
          const created = yield* developerconnect
            .createProjectsLocationsAccountConnectors({
              parent: parentOf(env.project, location),
              accountConnectorId,
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
        .deleteProjectsLocationsAccountConnectors({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
