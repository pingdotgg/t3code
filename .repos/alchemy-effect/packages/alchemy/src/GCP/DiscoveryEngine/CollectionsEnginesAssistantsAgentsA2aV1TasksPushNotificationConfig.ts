import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  parentBefore,
  parseResourceName,
  toResourceId,
} from "./internal.ts";

export type CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigProps =
  {
    /**
     * A2A tenant resource name, typically the assistant or agent:
     * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}/assistants/{assistant}`.
     * Immutable — changing it replaces the config.
     */
    tenant: string;
    /**
     * Parent task resource (`tasks/{task}`). Immutable — changing it
     * replaces the config.
     */
    parent: string;
    /**
     * Config id. If omitted, a unique id is generated. Immutable —
     * changing it replaces the config.
     */
    configId?: string;
    /**
     * Notification callback URL.
     */
    url: string;
    /**
     * Token sent with the notification.
     */
    token?: string;
    /**
     * Authentication schemes (Basic, Bearer, …).
     */
    schemes?: string[];
    /**
     * Authentication credentials.
     */
    credentials?: string;
  };

export type CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig =
  Resource<
    "GCP.DiscoveryEngine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig",
    CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigProps,
    {
      /** Full resource name (`tasks/{task}/pushNotificationConfigs/{config}`). */
      name: string;
      /** Config id (last path segment). */
      configId: string;
      /** A2A tenant resource name. */
      tenant: string;
      /** Parent task resource. */
      parent: string;
      /** Project id. */
      project: string;
      /** Notification callback URL. */
      url: string | undefined;
      /** Token. */
      token: string | undefined;
    },
    never,
    Providers
  >;

/**
 * An A2A task push-notification config on a Discovery Engine Assistant
 * agent.
 *
 * Experimental A2A API. There is no patch RPC, so URL / token / auth
 * changes replace the config. The config id is deterministic: `read`
 * reports a config it finds without prior state as unowned (adopt it
 * with `--adopt`).
 *
 * ### Creating a Push Notification Config
 * **Example:** Webhook on a task
 * ```typescript
 * const config =
 *   yield* GCP.DiscoveryEngine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig(
 *     "Notify",
 *     {
 *       tenant: assistant.name,
 *       parent: "tasks/support-1",
 *       url: "https://example.com/hooks/a2a",
 *     },
 *   );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig =
  Resource<CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig>(
    "GCP.DiscoveryEngine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig",
  );

export class CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, configId: string) =>
  `${parent}/pushNotificationConfigs/${configId}`;

const getByName = (tenant: string, name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
      { tenant, name },
    )
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  config: discoveryengine.A2aV1TaskPushNotificationConfig,
  project: string,
  tenant: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "pushNotificationConfigs");
  return {
    name,
    configId: parsed.id || lastSegment(name),
    tenant,
    parent: parentBefore(name, "pushNotificationConfigs"),
    project: parsed.project || project,
    url: config.pushNotificationConfig?.url,
    token: config.pushNotificationConfig?.token,
  };
};

export const CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigProvider =
  () =>
    Provider.succeed(
      CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig,
      {
        stables: ["name", "configId", "tenant", "parent", "project"],

        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          const previousTenant = olds?.tenant ?? output?.tenant;
          const previousParent = olds?.parent ?? output?.parent;
          const previousId = olds?.configId ?? output?.configId;
          const nextId = news.configId ?? previousId;
          const previousUrl = olds?.url ?? output?.url;
          if (
            (previousTenant !== undefined && news.tenant !== previousTenant) ||
            (previousParent !== undefined && news.parent !== previousParent) ||
            (previousId !== undefined &&
              nextId !== undefined &&
              nextId !== previousId) ||
            (previousUrl !== undefined && news.url !== previousUrl)
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const env = yield* GcpEnvironment.current;
          const tenant = olds?.tenant ?? output?.tenant;
          const parent = olds?.parent ?? output?.parent;
          const configId = yield* toResourceId(
            id,
            olds?.configId,
            output?.configId,
          );
          const name =
            output?.name ??
            (parent !== undefined ? resourceName(parent, configId) : undefined);
          if (tenant === undefined || name === undefined) return undefined;
          const existing = yield* getByName(tenant, name);
          if (existing === undefined) return undefined;
          const attrs = toAttrs(existing, env.project, tenant);
          // No labels field: without prior state it may not be ours.
          return output !== undefined ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const env = yield* GcpEnvironment.current;
          const configId = yield* toResourceId(
            id,
            news.configId,
            output?.configId,
          );
          const token = news.token;
          const fallbackName =
            output?.name ?? resourceName(news.parent, configId);

          let current = yield* getByName(news.tenant, fallbackName);

          if (current === undefined) {
            const created = yield* discoveryengine
              .createProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
                {
                  tenant: news.tenant,
                  parent: news.parent,
                  configId,
                  body: {
                    name: fallbackName,
                    pushNotificationConfig: {
                      url: news.url,
                      token,
                      id: configId,
                      authentication:
                        news.schemes !== undefined ||
                        news.credentials !== undefined
                          ? {
                              schemes: news.schemes,
                              credentials: news.credentials,
                            }
                          : undefined,
                    },
                  },
                },
              )
              .pipe(
                Effect.catchTag("Conflict", () =>
                  getByName(news.tenant, fallbackName),
                ),
              );
            current = created ?? undefined;
          }

          if (current === undefined) {
            return yield* new CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigNotResolved(
              { name: fallbackName },
            );
          }

          return toAttrs(current, env.project, news.tenant);
        }),

        delete: Effect.fn(function* ({ output }) {
          const existing = yield* getByName(output.tenant, output.name);
          if (existing === undefined) return;
          yield* discoveryengine
            .deleteProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
              {
                tenant: output.tenant,
                name: output.name,
              },
            )
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      },
    );
