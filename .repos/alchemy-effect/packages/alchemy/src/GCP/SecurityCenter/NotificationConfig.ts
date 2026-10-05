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
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOn,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type StreamingConfig = {
  /**
   * Finding filter. Empty matches every finding in the parent.
   */
  filter?: string;
};

export type NotificationConfigProps = {
  /**
   * Config id (the `{config}` segment of
   * `projects/{project}/notificationConfigs/{config}`). If omitted, a unique
   * id is generated. Letters, digits, and hyphens; must start with a letter;
   * max 63 characters. Immutable — changing it replaces the config.
   */
  configId?: string;
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

export type NotificationConfig = Resource<
  "GCP.SecurityCenter.NotificationConfig",
  NotificationConfigProps,
  {
    /** Full resource name `projects/{project}/notificationConfigs/{config}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Project id. */
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
 * A project-scoped Security Command Center notification config that
 * publishes findings to a Pub/Sub topic.
 *
 * Notification configs have no labels field — Alchemy stamps ownership
 * into the description so `list` / nuke can find them. Config id is
 * identity. Description, Pub/Sub topic, and streaming filter update in
 * place.
 *
 * ### Creating a Notification Config
 * **Example:** Publish high-severity findings
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("SccFindings", {});
 * const config = yield* GCP.SecurityCenter.NotificationConfig("High", {
 *   pubsubTopic: topic.name,
 *   description: "high severity",
 *   streamingConfig: { filter: 'severity="HIGH"' },
 * });
 * ```
 *
 * ### Updating a Notification Config
 * **Example:** Also publish critical findings
 * ```typescript
 * const config = yield* GCP.SecurityCenter.NotificationConfig("High", {
 *   pubsubTopic: topic.name,
 *   description: "high and critical",
 *   streamingConfig: { filter: 'severity="HIGH" OR severity="CRITICAL"' },
 * });
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const NotificationConfig = Resource<NotificationConfig>(
  "GCP.SecurityCenter.NotificationConfig",
);

export class NotificationConfigNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.NotificationConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, configId: string) =>
  `projects/${project}/notificationConfigs/${configId}`;

const streamingOf = (
  config: scc.StreamingConfig | StreamingConfig | undefined,
): StreamingConfig | undefined =>
  config === undefined ? undefined : { filter: config.filter };

const toAttrs = (config: scc.NotificationConfig, project: string) => {
  const name = config.name ?? "";
  const parsed = parseOwnership(config.description);
  return {
    name,
    configId: lastSegment(name),
    project: projectOf(name) || project,
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
        .getProjectsNotificationConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NotificationConfigProvider = () =>
  Provider.succeed(NotificationConfig, {
    stables: ["name", "configId", "project", "serviceAccount"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOn(olds?.configId ?? output?.configId, news.configId);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const configId = yield* toResourceId(
        id,
        olds?.configId,
        output?.configId,
        "n",
      );
      const name = output?.name ?? resourceName(env.project, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          scc.listProjectsNotificationConfigs.pages({
            parent: `projects/${env.project}`,
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
          .map((config) => toAttrs(config, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const configId = yield* toResourceId(
        id,
        news.configId,
        output?.configId,
        "n",
      );
      const name = resourceName(env.project, configId);
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
          .createProjectsNotificationConfigs({
            parent: `projects/${env.project}`,
            configId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NotificationConfigNotResolved({ name });
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
        current = yield* scc.patchProjectsNotificationConfigs({
          name: currentName,
          updateMask,
          body: {
            ...body,
            name: currentName,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteProjectsNotificationConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
