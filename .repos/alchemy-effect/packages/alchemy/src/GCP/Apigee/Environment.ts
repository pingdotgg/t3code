import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  defaultOrgName,
  desiredAttributes,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  letterPrefixedId,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  parseDescription,
  propertiesToRecord,
  recordToProperties,
  sameRecord,
  userProperties,
  waitForOperation,
} from "./operations.ts";

export type EnvironmentType =
  | apigee.GoogleCloudApigeeV1EnvironmentTypeEnum
  | (string & {});
export type EnvironmentApiProxyType =
  | apigee.GoogleCloudApigeeV1EnvironmentApiProxyTypeEnum
  | (string & {});
export type EnvironmentDeploymentType =
  | apigee.GoogleCloudApigeeV1EnvironmentDeploymentTypeEnum
  | (string & {});

export type EnvironmentClientIPResolutionConfig =
  apigee.GoogleCloudApigeeV1EnvironmentClientIPResolutionConfig;
export type EnvironmentNodeConfig = apigee.GoogleCloudApigeeV1NodeConfig;

export type EnvironmentProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the
   * environment.
   */
  organization?: string;
  /**
   * Environment id (the `{env}` segment of
   * `organizations/{org}/environments/{env}`). Must match
   * `^[.\\p{Alnum}-_]{1,255}$`. If omitted, a unique name is generated.
   * Immutable — changing it replaces the environment.
   */
  environmentId?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Environment type. Immutable — changing it replaces the environment.
   */
  type?: EnvironmentType;
  /**
   * API proxy type. Immutable — changing it replaces the environment.
   */
  apiProxyType?: EnvironmentApiProxyType;
  /**
   * Deployment type. Immutable — changing it replaces the environment.
   */
  deploymentType?: EnvironmentDeploymentType;
  /**
   * Forward proxy URI (`http://{hostname}:{port}`). Empty string removes
   * the setting.
   */
  forwardProxyUri?: string;
  /**
   * Client IP resolution algorithm used by analytics and API security.
   */
  clientIpResolutionConfig?: EnvironmentClientIPResolutionConfig;
  /**
   * Custom properties (name/value pairs). Alchemy ownership properties
   * are merged in automatically.
   */
  properties?: Record<string, string>;
  /**
   * Gateway node reservation.
   */
  nodeConfig?: EnvironmentNodeConfig;
};

export type Environment = Resource<
  "GCP.Apigee.Environment",
  EnvironmentProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}`. */
    name: string;
    /** Environment id (last path segment). */
    environmentId: string;
    /** Apigee organization id. */
    organization: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Environment type. */
    type: string | undefined;
    /** API proxy type. */
    apiProxyType: string | undefined;
    /** Deployment type. */
    deploymentType: string | undefined;
    /** Forward proxy URI. */
    forwardProxyUri: string | undefined;
    /** Client IP resolution config. */
    clientIpResolutionConfig: EnvironmentClientIPResolutionConfig | undefined;
    /** User properties (Alchemy ownership properties stripped). */
    properties: Record<string, string>;
    /** Gateway node reservation. */
    nodeConfig: EnvironmentNodeConfig | undefined;
    /** Whether flow hooks are attached. */
    hasAttachedFlowHooks: boolean | undefined;
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee environment that hosts API proxies and shared flows.
 *
 * Apigee environments have no labels field, so Alchemy stamps ownership
 * into the description (and properties) for `list` / nuke. Name, type,
 * API proxy type, and deployment type are identity — changing them
 * replaces the environment. Display name, description, forward proxy,
 * IP resolution, properties, and node config update in place.
 *
 * ### Creating an Environment
 * **Example:** Generated name
 * ```typescript
 * const environment = yield* GCP.Apigee.Environment("Runtime", {
 *   displayName: "runtime",
 * });
 * ```
 *
 * **Example:** Named environment with description
 * ```typescript
 * const environment = yield* GCP.Apigee.Environment("Runtime", {
 *   environmentId: "prod",
 *   displayName: "Production",
 *   description: "production API runtime",
 *   apiProxyType: "PROGRAMMABLE",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Environment = Resource<Environment>("GCP.Apigee.Environment");

export class EnvironmentNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, environmentId: string) =>
  `${orgNameOf(organization)}/environments/${environmentId}`;

const toAttrs = (
  environment: apigee.GoogleCloudApigeeV1Environment,
  organization: string,
) => {
  const name = environment.name ?? "";
  const parsed = parseDescription(environment.description);
  return {
    name,
    environmentId: lastSegment(name),
    organization: orgIdOf(organization),
    displayName: environment.displayName,
    description: parsed.description,
    type: environment.type,
    apiProxyType: environment.apiProxyType,
    deploymentType: environment.deploymentType,
    forwardProxyUri: environment.forwardProxyUri,
    clientIpResolutionConfig: environment.clientIpResolutionConfig,
    properties: userProperties(environment.properties),
    nodeConfig: environment.nodeConfig,
    hasAttachedFlowHooks: environment.hasAttachedFlowHooks,
    state: environment.state,
    createdAt: environment.createdAt,
    lastModifiedAt: environment.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsEnvironments({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: [
      "name",
      "environmentId",
      "organization",
      "type",
      "apiProxyType",
      "deploymentType",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.environmentId ?? output?.environmentId;
      const previousOrg = olds?.organization ?? output?.organization;
      const previousType = olds?.type ?? output?.type;
      const previousProxy = olds?.apiProxyType ?? output?.apiProxyType;
      const previousDeploy = olds?.deploymentType ?? output?.deploymentType;
      const idChanged =
        previousId !== undefined &&
        news.environmentId !== undefined &&
        news.environmentId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      const typeChanged =
        previousType !== undefined &&
        news.type !== undefined &&
        news.type !== previousType;
      const proxyChanged =
        previousProxy !== undefined &&
        news.apiProxyType !== undefined &&
        news.apiProxyType !== previousProxy;
      const deployChanged =
        previousDeploy !== undefined &&
        news.deploymentType !== undefined &&
        news.deploymentType !== previousDeploy;
      if (
        idChanged ||
        orgChanged ||
        typeChanged ||
        proxyChanged ||
        deployChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst: idChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const environmentId = yield* letterPrefixedId(
        id,
        olds?.environmentId,
        output?.environmentId,
        255,
      );
      const name = output?.name ?? resourceName(organization, environmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: Environment["Attributes"][] = [];
        for (const organization of orgs) {
          const org = yield* apigee
            .getOrganizations({ name: organization })
            .pipe(
              Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          for (const environmentId of org?.environments ?? []) {
            const existing = yield* getByName(
              `${organization}/environments/${environmentId}`,
            );
            if (
              existing !== undefined &&
              hasOwnershipMarker(existing.description)
            ) {
              rows.push(toAttrs(existing, organization));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const environmentId = yield* letterPrefixedId(
        id,
        news.environmentId,
        output?.environmentId,
        255,
      );
      const name = resourceName(organization, environmentId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const properties = desiredAttributes(news.properties, ownership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* apigee
          .createOrganizationsEnvironments({
            parent: organization,
            name: environmentId,
            body: {
              name: environmentId,
              displayName: news.displayName,
              description: desiredDescription,
              type: news.type,
              apiProxyType: news.apiProxyType,
              deploymentType: news.deploymentType,
              forwardProxyUri: news.forwardProxyUri,
              clientIpResolutionConfig: news.clientIpResolutionConfig,
              properties: recordToProperties(properties),
              nodeConfig: news.nodeConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new EnvironmentNotResolved({ name });
      }

      const observedProperties = propertiesToRecord(current.properties);
      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const proxyUriChanged =
        (current.forwardProxyUri ?? "") !== (news.forwardProxyUri ?? "");
      const ipChanged = !jsonEqual(
        current.clientIpResolutionConfig,
        news.clientIpResolutionConfig,
      );
      const propertiesChanged = !sameRecord(observedProperties, properties);
      const nodeChanged = !jsonEqual(current.nodeConfig, news.nodeConfig);

      if (
        displayChanged ||
        descriptionChanged ||
        proxyUriChanged ||
        ipChanged ||
        propertiesChanged ||
        nodeChanged
      ) {
        current = yield* apigee.updateOrganizationsEnvironments({
          name,
          body: {
            name: environmentId,
            displayName: news.displayName,
            description: desiredDescription,
            type: current.type,
            apiProxyType: current.apiProxyType,
            deploymentType: current.deploymentType,
            forwardProxyUri: news.forwardProxyUri,
            clientIpResolutionConfig: news.clientIpResolutionConfig,
            properties: recordToProperties(properties),
            nodeConfig: news.nodeConfig ?? current.nodeConfig,
          },
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsEnvironments({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
