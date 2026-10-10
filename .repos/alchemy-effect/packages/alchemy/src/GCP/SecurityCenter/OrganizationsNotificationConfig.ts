import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  organizationParent,
  ownedByAlchemy,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  toResourceId,
  tryResolveOrganization,
  updateMaskOf,
} from "./internal.ts";
import type { StreamingConfig } from "./NotificationConfig.ts";

export type OrganizationsNotificationConfigProps = {
  /**
   * Config id (the `{config}` segment of
   * `organizations/{organization}/notificationConfigs/{config}`). If omitted,
   * a unique id is generated. Letters, digits, and hyphens; must start with
   * a letter; max 63 characters. Immutable — changing it replaces the config.
   */
  configId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric id).
   * Defaults to the project's Resource Manager
   * ancestor. Immutable — changing it replaces the config.
   */
  organization?: string;
  /**
   * Pub/Sub topic that receives findings, as
   * `projects/{project}/topics/{topic}`.
   */
  pubsubTopic: string;
  /**
   * Human-readable description (max 1024 characters). Notification configs
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Streaming config. `filter` selects which findings are published.
   */
  streamingConfig?: StreamingConfig;
};

export type OrganizationsNotificationConfig = Resource<
  "GCP.SecurityCenter.OrganizationsNotificationConfig",
  OrganizationsNotificationConfigProps,
  {
    /** Full resource name `organizations/{organization}/notificationConfigs/{config}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Pub/Sub topic findings are published to. */
    pubsubTopic: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Streaming config. */
    streamingConfig: StreamingConfig | undefined;
    /** Service account SCC uses to publish. */
    serviceAccount: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Security Command Center notification config that
 * publishes findings to a Pub/Sub topic.
 *
 * Notification configs have no labels field — Alchemy stamps ownership
 * into the description so `list` / nuke can find them. Config id and
 * organization are identity. Description, Pub/Sub topic, and streaming
 * filter update in place.
 *
 * ### Creating a Notification Config
 * **Example:** Publish high-severity findings
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("OrgFindings", {});
 * const config = yield* GCP.SecurityCenter.OrganizationsNotificationConfig(
 *   "High",
 *   {
 *     pubsubTopic: topic.name,
 *     description: "high severity",
 *     streamingConfig: { filter: 'severity="HIGH"' },
 *   },
 * );
 * ```
 *
 * **Example:** Named config on an explicit organization
 * ```typescript
 * const config = yield* GCP.SecurityCenter.OrganizationsNotificationConfig(
 *   "High",
 *   {
 *     organization: "organizations/123456789",
 *     configId: "high-findings",
 *     pubsubTopic: topic.name,
 *     streamingConfig: { filter: 'severity="HIGH"' },
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const OrganizationsNotificationConfig =
  Resource<OrganizationsNotificationConfig>(
    "GCP.SecurityCenter.OrganizationsNotificationConfig",
  );

export class OrganizationsNotificationConfigNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.OrganizationsNotificationConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, configId: string) =>
  `${organization}/notificationConfigs/${configId}`;

const streamingOf = (
  config: scc.StreamingConfig | StreamingConfig | undefined,
): StreamingConfig | undefined =>
  config === undefined ? undefined : { filter: config.filter };

const toAttrs = (
  config: scc.NotificationConfig,
  organization: string,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseOwnership(config.description);
  return {
    name,
    configId: lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    project,
    pubsubTopic: config.pubsubTopic,
    description: parsed.text,
    streamingConfig: streamingOf(config.streamingConfig),
    serviceAccount: config.serviceAccount,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getOrganizationsNotificationConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationsNotificationConfigProvider = () =>
  Provider.succeed(OrganizationsNotificationConfig, {
    stables: [
      "name",
      "configId",
      "organization",
      "organizationId",
      "project",
      "serviceAccount",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.configId ?? output?.configId, news.configId) ??
        replaceOn(
          olds?.organization ?? output?.organization,
          news.organization === undefined
            ? undefined
            : organizationParent(news.organization),
        )
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const configId = yield* toResourceId(
        id,
        olds?.configId,
        output?.configId,
        "n",
      );
      const name = output?.name ?? resourceName(organization, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const items = yield* collectPages(
          scc.listOrganizationsNotificationConfigs.pages({
            parent: organization,
            pageSize: 100,
          }),
          (page) => page.notificationConfigs,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as scc.NotificationConfig[]),
          ),
        );
        return items
          .filter((config) => hasOwnershipMarker(config.description))
          .map((config) => toAttrs(config, organization, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const configId = yield* toResourceId(
        id,
        news.configId,
        output?.configId,
        "n",
      );
      const name = resourceName(organization, configId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const filter = news.streamingConfig?.filter ?? "";
      const body: scc.NotificationConfig = {
        pubsubTopic: news.pubsubTopic,
        description,
        streamingConfig: { filter },
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createOrganizationsNotificationConfigs({
            parent: organization,
            configId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationsNotificationConfigNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(current.description, description);
      const topicChanged = !sameText(current.pubsubTopic, news.pubsubTopic);
      const filterChanged = !sameText(current.streamingConfig?.filter, filter);
      const updateMask = updateMaskOf(
        descriptionChanged ? "description" : undefined,
        topicChanged ? "pubsub_topic" : undefined,
        filterChanged ? "streaming_config.filter" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchOrganizationsNotificationConfigs({
          name: currentName,
          updateMask,
          body: {
            ...body,
            name: currentName,
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteOrganizationsNotificationConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
