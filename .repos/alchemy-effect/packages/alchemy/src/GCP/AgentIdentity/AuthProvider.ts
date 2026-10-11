import * as agentidentity from "@distilled.cloud/gcp/agentidentity_v1";
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
  AuthProviderNotResolved,
  clipDescription,
  fieldMask,
  fingerprint,
  getByName,
  hasSecretUpdate,
  listOwned,
  normalizeLocation,
  parseName,
  publicTypeParams,
  resourceName,
  sameStringList,
  sameText,
  toPhysicalId,
  toTypeParams,
  typeParamsBody,
  userLabels,
  type ApiKeyParams,
  type AuthProviderTypeParams,
  type ThreeLeggedOAuthParams,
  type TwoLeggedOAuthParams,
} from "./internal.ts";

export type {
  ApiKeyParams,
  AuthProviderTypeParams,
  ThreeLeggedOAuthParams,
  TwoLeggedOAuthParams,
};

export type AuthProviderProps = {
  /**
   * Auth provider id (the `{auth_provider}` segment of
   * `projects/{project}/locations/{location}/authProviders/{auth_provider}`).
   * If omitted, a unique RFC1035 name is generated. Must be 1-63
   * characters, start with a lowercase letter, and use only `a-z` and
   * `-`. Immutable — changing it replaces the auth provider.
   */
  authProviderId?: string;
  /**
   * Location of the auth provider. Immutable — changing it replaces the
   * auth provider.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description (max 256 characters).
   */
  description?: string;
  /**
   * Scopes that may be requested. Empty or omitted allows every scope
   * except those in `blockedScopes`. At most 200 entries.
   */
  allowedScopes?: string[];
  /**
   * Scopes that must not be requested. Takes precedence over
   * `allowedScopes`. At most 200 entries.
   */
  blockedScopes?: string[];
  /**
   * Workload identities (`principal://…`) of the agents that use this
   * auth provider. Input-only — omitted from attributes.
   */
  workloadIds?: string[];
  /**
   * When true, the auth provider is disabled via `:disable`. Defaults to
   * enabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * Auth method parameters. Required on create. Exactly one of
   * `threeLeggedOauth`, `twoLeggedOauth`, `apiKey`, or `geAuthProvider`
   * should be set. Client secrets and API keys are input-only.
   */
  authProviderTypeParams: AuthProviderTypeParams;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AuthProvider = Resource<
  "GCP.AgentIdentity.AuthProvider",
  AuthProviderProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authProviders/{auth_provider}`. */
    name: string;
    /** Auth provider id (last path segment). */
    authProviderId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** Allowed OAuth scopes. */
    allowedScopes: string[];
    /** Blocked OAuth scopes. */
    blockedScopes: string[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Public auth method parameters (secrets stripped). */
    authProviderTypeParams: AuthProviderTypeParams | undefined;
    /** Server-reported state (`ENABLED`, `DISABLED`, …). */
    state: string | undefined;
    /** Whether the auth provider is disabled. */
    disabled: boolean;
    /** RFC3339 time the auth provider expires, if any. */
    expireTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Agent Identity auth provider — the credential configuration agents
 * use to call third-party APIs (API keys, 2LO, or 3LO OAuth).
 *
 * `authProviderId` and `location` replace the resource. Description,
 * labels, scopes, type parameters, and enabled/disabled update in place.
 *
 * ### Creating an Auth Provider
 * **Example:** API key
 * ```typescript
 * const auth = yield* GCP.AgentIdentity.AuthProvider("Maps", {
 *   authProviderTypeParams: {
 *     apiKey: { apiKey: "maps-api-key" },
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Three-legged OAuth
 * ```typescript
 * const auth = yield* GCP.AgentIdentity.AuthProvider("Atlassian", {
 *   authProviderTypeParams: {
 *     threeLeggedOauth: {
 *       clientId: "jira-client",
 *       clientSecret: "jira-secret",
 *       authorizationUrl: "https://auth.atlassian.com/authorize",
 *       tokenUrl: "https://auth.atlassian.com/oauth/token",
 *       enablePkce: true,
 *     },
 *   },
 *   allowedScopes: ["read:jira-work"],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Auth Provider
 * **Example:** Description and labels
 * ```typescript
 * const auth = yield* GCP.AgentIdentity.AuthProvider("Maps", {
 *   authProviderId: "maps",
 *   authProviderTypeParams: {
 *     apiKey: { apiKey: "maps-api-key" },
 *   },
 *   description: "Maps API key for agents",
 *   labels: { env: "prod", role: "maps" },
 * });
 * ```
 *
 * @resource
 * @category AgentIdentity
 */
export const AuthProvider = Resource<AuthProvider>(
  "GCP.AgentIdentity.AuthProvider",
);

export { AuthProviderNotResolved };

const toAttrs = (
  item: agentidentity.AuthProvider,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, region);
  const state = item.state;
  return {
    name,
    authProviderId: parsed.authProviderId,
    project: parsed.project || project,
    location: parsed.location,
    description: item.description,
    allowedScopes: item.allowedScopes ?? [],
    blockedScopes: item.blockedScopes ?? [],
    labels: userLabels(item.labels),
    authProviderTypeParams: toTypeParams(item.authProviderTypeParams),
    state,
    disabled: state === "DISABLED",
    expireTime: item.expireTime,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.nextId !== input.previousId;
  const locationChanged = input.previousLocation !== input.nextLocation;
  if (!idChanged && !locationChanged) return undefined;
  return {
    action: "replace" as const,
    deleteFirst:
      locationChanged &&
      !idChanged &&
      input.previousId !== undefined &&
      input.nextId === input.previousId,
  };
};

export const AuthProviderProvider = () =>
  Provider.succeed(AuthProvider, {
    stables: ["name", "authProviderId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.authProviderId ?? output?.authProviderId,
        nextId:
          news.authProviderId ?? olds?.authProviderId ?? output?.authProviderId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authProviderId = yield* toPhysicalId(
        id,
        olds?.authProviderId,
        output?.authProviderId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, authProviderId);
      const existing = yield* getByName(name);
      if (existing === undefined || existing.deleted === true) {
        return undefined;
      }
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

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authProviderId = yield* toPhysicalId(
        id,
        news.authProviderId,
        output?.authProviderId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, authProviderId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const description = clipDescription(news.description);
      const allowedScopes = news.allowedScopes ?? [];
      const blockedScopes = news.blockedScopes ?? [];
      const workloadIds = news.workloadIds;
      const typeParams = typeParamsBody(news.authProviderTypeParams);

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && current.deleted === true) {
        current = yield* agentidentity
          .undeleteProjectsLocationsAuthProviders({
            name: current.name ?? name,
            body: {},
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      }

      if (current === undefined) {
        const created = yield* agentidentity
          .createProjectsLocationsAuthProviders({
            parent: `projects/${env.project}/locations/${location}`,
            authProviderId,
            body: {
              labels: desiredLabels,
              description,
              allowedScopes:
                allowedScopes.length > 0 ? allowedScopes : undefined,
              blockedScopes:
                blockedScopes.length > 0 ? blockedScopes : undefined,
              workloadIds:
                workloadIds !== undefined && workloadIds.length > 0
                  ? workloadIds
                  : undefined,
              authProviderTypeParams: typeParams,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getByName(output?.name ?? name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AuthProviderNotResolved({ name });
      }

      const resource = current.name ?? name;
      if (current.deleted === true) {
        current = yield* agentidentity.undeleteProjectsLocationsAuthProviders({
          name: resource,
          body: {},
        });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = !sameText(current.description, description);
      const allowedChanged = !sameStringList(
        current.allowedScopes,
        allowedScopes,
      );
      const blockedChanged = !sameStringList(
        current.blockedScopes,
        blockedScopes,
      );
      const observedTypeParams = publicTypeParams(
        toTypeParams(current.authProviderTypeParams),
      );
      const desiredTypeParams = publicTypeParams(news.authProviderTypeParams);
      const typeParamsChanged =
        (observedTypeParams !== undefined &&
          fingerprint(observedTypeParams) !== fingerprint(desiredTypeParams)) ||
        hasSecretUpdate(
          news.authProviderTypeParams,
          olds?.authProviderTypeParams,
        );
      const workloadChanged =
        workloadIds !== undefined &&
        olds !== undefined &&
        !sameStringList(olds.workloadIds, workloadIds);

      const mask = fieldMask([
        labelsChanged && "labels",
        descriptionChanged && "description",
        allowedChanged && "allowedScopes",
        blockedChanged && "blockedScopes",
        typeParamsChanged && "authProviderTypeParams",
        workloadChanged && "workloadIds",
      ]);

      if (mask.length > 0) {
        current = yield* agentidentity.patchProjectsLocationsAuthProviders({
          name: resource,
          updateMask: mask,
          body: {
            name: resource,
            labels: desiredLabels,
            description,
            allowedScopes,
            blockedScopes,
            workloadIds,
            authProviderTypeParams: typeParams,
          },
        });
      }

      const desiredDisabled = news.disabled === true;
      const observedDisabled = current.state === "DISABLED";
      if (desiredDisabled && !observedDisabled) {
        current = yield* agentidentity.disableProjectsLocationsAuthProviders({
          name: current.name ?? resource,
          body: {},
        });
      } else if (!desiredDisabled && observedDisabled) {
        current = yield* agentidentity.enableProjectsLocationsAuthProviders({
          name: current.name ?? resource,
          body: {},
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* agentidentity
        .deleteProjectsLocationsAuthProviders({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
