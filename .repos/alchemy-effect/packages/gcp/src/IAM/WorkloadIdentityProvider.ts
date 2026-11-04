import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";
import { encodeOwnedDescription, parseOwnedDescription } from "./internal.ts";

const PROVIDER_ID_MAX = 32;

export type WorkloadIdentityProviderOidc = {
  /** Issuer URL (HTTPS), e.g. `https://token.actions.githubusercontent.com`. */
  issuerUri: string;
  /**
   * Accepted `aud` values. When empty, the token audience must be the
   * provider's full resource name.
   */
  allowedAudiences?: string[];
  /** Inline JWKS (JSON). When omitted, keys are fetched from the issuer. */
  jwksJson?: string;
};

export type WorkloadIdentityProviderProps = {
  /** Project that owns the pool. Defaults to the current GCP project. */
  project?: string;
  /** Id of the pool the provider belongs to. Changing it replaces the provider. */
  workloadIdentityPoolId: string;
  /**
   * Provider id: 4-32 lowercase letters, digits, or hyphens (the `gcp-`
   * prefix is reserved). If omitted, a unique id is generated. Changing it
   * replaces the provider. Deleted providers keep their id for 30 days;
   * redeploying the same id in that window restores the provider.
   */
  workloadIdentityPoolProviderId?: string;
  /** Display name (maximum 32 characters). */
  displayName?: string;
  /**
   * Description. Providers have no labels, so Alchemy stamps ownership into a
   * `[alchemy …]` prefix and strips it from the `description` attribute.
   */
  description?: string;
  /**
   * Disable the provider. Tokens from its issuer cannot be exchanged while it
   * is disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * Maps issuer token claims to Google attributes, e.g.
   * `{ "google.subject": "assertion.sub" }`. When omitted, the existing
   * mapping is left as is.
   */
  attributeMapping?: Record<string, string>;
  /**
   * CEL expression a token must satisfy, e.g.
   * `assertion.repository == "my-org/my-repo"`. When omitted, the existing
   * condition is left as is.
   */
  attributeCondition?: string;
  /** OpenID Connect issuer. Set exactly one of `oidc`, `aws`, or `saml`. */
  oidc?: WorkloadIdentityProviderOidc;
  /** AWS account whose identities may federate. */
  aws?: { accountId: string };
  /** SAML 2.0 identity provider metadata (XML). */
  saml?: { idpMetadataXml: string };
};

export type WorkloadIdentityProvider = Resource<
  "GCP.IAM.WorkloadIdentityProvider",
  WorkloadIdentityProviderProps,
  {
    /**
     * Full resource name as GCP returns it, with the project number:
     * `projects/{projectNumber}/locations/global/workloadIdentityPools/{pool}/providers/{id}`.
     */
    name: string;
    /** Project that owns the pool. */
    project: string;
    /** Pool id. */
    workloadIdentityPoolId: string;
    /** Provider id. */
    workloadIdentityPoolProviderId: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether the provider is disabled. */
    disabled: boolean;
    /** Attribute mapping. */
    attributeMapping: Record<string, string> | undefined;
    /** Attribute condition. */
    attributeCondition: string | undefined;
    /** OpenID Connect issuer settings. */
    oidc: WorkloadIdentityProviderOidc | undefined;
    /** AWS settings. */
    aws: { accountId: string } | undefined;
    /** Provider state (`ACTIVE` or `DELETED`). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * An issuer in a Google Cloud IAM workload identity pool (a "workload
 * identity pool provider"). Tokens from the issuer that pass the attribute
 * condition can be exchanged for short-lived Google credentials.
 *
 * ### GitHub Actions
 * **Example:** Trust one repository and let its `main` branch deploy
 * ```typescript
 * const pool = yield* GCP.IAM.WorkloadIdentityPool("GitHub", {
 *   workloadIdentityPoolId: "github-actions",
 * });
 * yield* GCP.IAM.WorkloadIdentityProvider("GitHubOidc", {
 *   workloadIdentityPoolId: pool.workloadIdentityPoolId,
 *   workloadIdentityPoolProviderId: "github",
 *   attributeMapping: {
 *     "google.subject": "assertion.sub",
 *     "attribute.repository": "assertion.repository",
 *   },
 *   attributeCondition: `assertion.repository == "my-org/my-repo"`,
 *   oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
 * });
 * ```
 *
 * ### AWS
 * **Example:** Trust roles in one AWS account
 * ```typescript
 * yield* GCP.IAM.WorkloadIdentityProvider("Aws", {
 *   workloadIdentityPoolId: pool.workloadIdentityPoolId,
 *   attributeMapping: {
 *     "google.subject": "assertion.arn",
 *     "attribute.aws_role": "assertion.arn.extract('assumed-role/{role}/')",
 *   },
 *   aws: { accountId: "123456789012" },
 * });
 * ```
 *
 * ### Replacing and restoring <!-- api-prose -->
 * Changing `workloadIdentityPoolId` or `workloadIdentityPoolProviderId`
 * replaces the provider. GCP keeps a deleted provider for 30 days and
 * reserves its id; deploying that id again restores it and re-applies the
 * declared settings.
 *
 * @resource
 * @category IAM
 */
export const WorkloadIdentityProvider = Resource<WorkloadIdentityProvider>(
  "GCP.IAM.WorkloadIdentityProvider",
);

export class WorkloadIdentityProviderNotResolved extends Data.TaggedError(
  "GCP.IAM.WorkloadIdentityProviderNotResolved",
)<{ resourceName: string }> {}

const providerName = (project: string, poolId: string, providerId: string) =>
  `projects/${project}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

const toOidc = (oidc: iam.Oidc | undefined): WorkloadIdentityProviderOidc | undefined =>
  oidc?.issuerUri === undefined
    ? undefined
    : {
        issuerUri: oidc.issuerUri,
        ...(oidc.allowedAudiences?.length ? { allowedAudiences: [...oidc.allowedAudiences] } : {}),
        ...(oidc.jwksJson ? { jwksJson: oidc.jwksJson } : {}),
      };

const toMap = (map: iam.StringMap | undefined): Record<string, string> | undefined =>
  map === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(map).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );

const toAttrs = (
  provider: iam.WorkloadIdentityPoolProvider,
  project: string,
  poolId: string,
  providerId: string,
): WorkloadIdentityProvider["Attributes"] => ({
  name: provider.name ?? providerName(project, poolId, providerId),
  project,
  workloadIdentityPoolId: poolId,
  workloadIdentityPoolProviderId: providerId,
  displayName: provider.displayName || undefined,
  description: parseOwnedDescription(provider.description).description,
  disabled: provider.disabled === true,
  attributeMapping: toMap(provider.attributeMapping),
  attributeCondition: provider.attributeCondition || undefined,
  oidc: toOidc(provider.oidc),
  aws: provider.aws?.accountId ? { accountId: provider.aws.accountId } : undefined,
  state: provider.state,
});

const getProvider = (name: string) =>
  iam
    .getProjectsLocationsWorkloadIdentityPoolsProviders({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitForProviderOperation = (operation: iam.Operation) =>
  waitForOperation(operation, (name) =>
    iam.getProjectsLocationsWorkloadIdentityPoolsProvidersOperations({ name }),
  );

const toProviderId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      prefix: `alchemy-${id}-`,
      maxLength: PROVIDER_ID_MAX,
      lowercase: true,
      forbiddenPrefixes: ["gcp-"],
    });
  });

const sameMap = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
};

const sameOidc = (current: iam.Oidc | undefined, desired: WorkloadIdentityProviderOidc) =>
  (current?.issuerUri ?? "") === desired.issuerUri &&
  JSON.stringify([...(current?.allowedAudiences ?? [])].sort()) ===
    JSON.stringify([...(desired.allowedAudiences ?? [])].sort()) &&
  (current?.jwksJson ?? "") === (desired.jwksJson ?? "");

export const WorkloadIdentityProviderProvider = () =>
  Provider.succeed(WorkloadIdentityProvider, {
    stables: ["name", "project", "workloadIdentityPoolId", "workloadIdentityPoolProviderId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = olds?.project ?? output?.project ?? env.project;
      const previousPoolId = olds?.workloadIdentityPoolId ?? output?.workloadIdentityPoolId;
      const previousProviderId =
        olds?.workloadIdentityPoolProviderId ?? output?.workloadIdentityPoolProviderId;
      if (
        (news.project !== undefined && news.project !== previousProject) ||
        (previousPoolId !== undefined && news.workloadIdentityPoolId !== previousPoolId) ||
        (news.workloadIdentityPoolProviderId !== undefined &&
          news.workloadIdentityPoolProviderId !== previousProviderId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const poolId = olds?.workloadIdentityPoolId ?? output?.workloadIdentityPoolId;
      if (poolId === undefined) return undefined;
      const providerId = yield* toProviderId(
        id,
        olds?.workloadIdentityPoolProviderId,
        output?.workloadIdentityPoolProviderId,
      );
      const existing = yield* getProvider(providerName(project, poolId, providerId));
      if (existing === undefined || existing.state === "DELETED") return undefined;
      const attrs = toAttrs(existing, project, poolId, providerId);
      const { labels } = parseOwnedDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? output?.project ?? env.project;
      const poolId = news.workloadIdentityPoolId;
      const providerId = yield* toProviderId(
        id,
        news.workloadIdentityPoolProviderId,
        output?.workloadIdentityPoolProviderId,
      );
      const name = providerName(project, poolId, providerId);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnedDescription(internal, news.description);
      const desiredDisabled = news.disabled === true;

      // Observe
      let current = yield* getProvider(name);

      // Ensure — the id stays reserved for 30 days after delete, so a
      // soft-deleted provider is restored rather than re-created.
      if (current === undefined) {
        const operation = yield* iam.createProjectsLocationsWorkloadIdentityPoolsProviders({
          parent: `projects/${project}/locations/global/workloadIdentityPools/${poolId}`,
          workloadIdentityPoolProviderId: providerId,
          body: {
            displayName: news.displayName,
            description: desiredDescription,
            disabled: desiredDisabled,
            attributeMapping: news.attributeMapping,
            attributeCondition: news.attributeCondition,
            oidc: news.oidc,
            aws: news.aws,
            saml: news.saml,
          },
        });
        yield* waitForProviderOperation(operation);
      } else if (current.state === "DELETED") {
        const operation = yield* iam.undeleteProjectsLocationsWorkloadIdentityPoolsProviders({
          name,
          body: {},
        });
        yield* waitForProviderOperation(operation);
      }
      current = yield* getProvider(name).pipe(
        Effect.flatMap((provider) =>
          provider === undefined || provider.state !== "ACTIVE"
            ? Effect.fail(new WorkloadIdentityProviderNotResolved({ resourceName: name }))
            : Effect.succeed(provider),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.IAM.WorkloadIdentityProviderNotResolved",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      // Sync against observed state. Mapping, condition, and issuer settings
      // are only managed when declared.
      const body: iam.WorkloadIdentityPoolProvider = {};
      const updateMask: string[] = [];
      if ((current.displayName ?? "") !== (news.displayName ?? "")) {
        updateMask.push("displayName");
        body.displayName = news.displayName ?? "";
      }
      if ((current.description ?? "") !== desiredDescription) {
        updateMask.push("description");
        body.description = desiredDescription;
      }
      if ((current.disabled === true) !== desiredDisabled) {
        updateMask.push("disabled");
        body.disabled = desiredDisabled;
      }
      if (
        news.attributeMapping !== undefined &&
        !sameMap(toMap(current.attributeMapping), news.attributeMapping)
      ) {
        updateMask.push("attributeMapping");
        body.attributeMapping = news.attributeMapping;
      }
      if (
        news.attributeCondition !== undefined &&
        (current.attributeCondition ?? "") !== news.attributeCondition
      ) {
        updateMask.push("attributeCondition");
        body.attributeCondition = news.attributeCondition;
      }
      if (news.oidc !== undefined && !sameOidc(current.oidc, news.oidc)) {
        updateMask.push("oidc");
        body.oidc = news.oidc;
      }
      if (news.aws !== undefined && current.aws?.accountId !== news.aws.accountId) {
        updateMask.push("aws");
        body.aws = news.aws;
      }
      if (news.saml !== undefined && current.saml?.idpMetadataXml !== news.saml.idpMetadataXml) {
        updateMask.push("saml");
        body.saml = news.saml;
      }
      if (updateMask.length > 0) {
        const operation = yield* iam.patchProjectsLocationsWorkloadIdentityPoolsProviders({
          name,
          updateMask: updateMask.join(","),
          body,
        });
        yield* waitForProviderOperation(operation);
        current = { ...current, ...body };
      }
      return toAttrs(current, project, poolId, providerId);
    }),

    // Soft delete: the provider is recoverable (and its id reserved) for 30 days.
    delete: Effect.fn(function* ({ output }) {
      // Reads lag behind create, so a NotFound here is not proof the
      // resource is gone; only an observed DELETED state skips the call.
      const current = yield* getProvider(output.name);
      if (current?.state === "DELETED") return;
      const operation = yield* iam
        .deleteProjectsLocationsWorkloadIdentityPoolsProviders({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) yield* waitForProviderOperation(operation);
    }),
  });
