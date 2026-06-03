import * as zaraz from "@distilled.cloud/cloudflare/zaraz";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  stripNullFields,
  stripUndefinedFields,
  unwrapRedacted,
} from "../../Util/data.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type ZoneReference } from "../Zone/index.ts";
import { defineZarazEvents } from "./ZarazEventTypes.ts";

export type ZarazWorkflow = zaraz.GetWorkflowResponse;
export type ZarazSettings = zaraz.PutConfigRequest["settings"];
export type ZarazAnalytics = NonNullable<zaraz.PutConfigRequest["analytics"]>;
export type ZarazConsent = NonNullable<zaraz.PutConfigRequest["consent"]>;

export type ZarazConfigProps = {
  /**
   * Zone whose Zaraz config should be managed. Accepts a zone id, a zone name
   * (`example.com`), or a `{ zoneId, name? }` object.
   */
  zone: ZoneReference;
  /**
   * Data layer compatibility mode.
   */
  dataLayer?: boolean;
  /**
   * Key used for Zaraz debug mode. Defaults to the current zone config value.
   */
  debugKey?: string;
  /**
   * Zaraz settings to merge into the current zone config.
   */
  settings?: Partial<ZarazSettings>;
  /**
   * Zaraz tools keyed by tool id. When omitted, existing tools are retained.
   */
  tools?: Record<string, unknown>;
  /**
   * Zaraz triggers keyed by trigger id. When omitted, existing triggers are
   * retained.
   */
  triggers?: Record<string, unknown>;
  /**
   * Zaraz variables keyed by variable id. When omitted, existing variables are
   * retained. Secret variable values are not returned by Cloudflare reads.
   */
  variables?: Record<string, unknown>;
  /**
   * Cloudflare Monitoring settings.
   */
  analytics?: ZarazAnalytics;
  /**
   * Zaraz consent management configuration.
   */
  consent?: ZarazConsent;
  /**
   * Single Page Application support.
   */
  historyChange?: boolean;
  /**
   * Zaraz workflow mode. When omitted, the current workflow is retained.
   */
  workflow?: ZarazWorkflow;
  /**
   * Whether destroy should restore Cloudflare's default Zaraz config.
   *
   * By default, destroy only removes this resource from Alchemy state and keeps
   * the current zone-level Zaraz config intact.
   * If `workflow` is set, `delete: true` restores the workflow to real-time
   * mode, Cloudflare's default.
   * @default false
   */
  delete?: boolean;
};

export type ZarazConfig = Resource<
  "Cloudflare.ZarazConfig",
  ZarazConfigProps,
  ZarazConfigAttributes,
  never,
  Providers
>;

export type ZarazConfigAttributes = {
  /**
   * Cloudflare zone id.
   */
  zoneId: string;
  /**
   * Data layer compatibility mode.
   */
  dataLayer: boolean;
  /**
   * Key used for Zaraz debug mode.
   */
  debugKey: string;
  /**
   * General Zaraz settings.
   */
  settings: zaraz.GetConfigResponse["settings"];
  /**
   * Zaraz tools keyed by tool id.
   */
  tools: Record<string, unknown>;
  /**
   * Zaraz triggers keyed by trigger id.
   */
  triggers: Record<string, unknown>;
  /**
   * Zaraz variables keyed by variable id.
   */
  variables: Record<string, unknown>;
  /**
   * Zaraz internal version of the config.
   */
  zarazVersion: number;
  /**
   * Cloudflare Monitoring settings.
   */
  analytics?: zaraz.GetConfigResponse["analytics"];
  /**
   * Consent management configuration.
   */
  consent?: zaraz.GetConfigResponse["consent"];
  /**
   * Single Page Application support.
   */
  historyChange?: boolean | null;
  /**
   * Current Zaraz workflow mode.
   */
  workflow: ZarazWorkflow;
};

/**
 * A Cloudflare Zaraz zone configuration.
 *
 * Cloudflare Zaraz is an edge-managed third-party tool manager and analytics
 * event pipeline. See the
 * {@link https://developers.cloudflare.com/zaraz/ | Cloudflare Zaraz docs} and
 * {@link https://developers.cloudflare.com/zaraz/web-api/ | Web API docs}.
 *
 * Zaraz is a zone-level singleton. This resource reconciles the current zone
 * config and workflow to the desired values while retaining existing settings
 * for fields omitted from props.
 *
 * Destroy keeps the current Zaraz config by default to avoid wiping unrelated
 * zone-level analytics setup. Set `delete: true` to restore Cloudflare's
 * default Zaraz config on destroy.
 *
 * @section Managing Zaraz
 * @example Enable data layer compatibility
 * ```typescript
 * const zaraz = yield* Cloudflare.ZarazConfig("Analytics", {
 *   zone: "example.com",
 *   dataLayer: true,
 * });
 * ```
 *
 * @example Update Zaraz settings
 * ```typescript
 * const zaraz = yield* Cloudflare.ZarazConfig("Analytics", {
 *   zone: "example.com",
 *   settings: {
 *     autoInjectScript: true,
 *     hideIPAddress: true,
 *   },
 * });
 * ```
 *
 * @example Enable preview workflow
 * ```typescript
 * const zaraz = yield* Cloudflare.ZarazConfig("Analytics", {
 *   zone: "example.com",
 *   workflow: "preview",
 * });
 * ```
 */
export const ZarazConfig = Object.assign(
  Resource<ZarazConfig>("Cloudflare.ZarazConfig"),
  {
    /**
     * Define a type-only contract for the events sent through this Zaraz config.
     *
     * The returned value carries only types. Browser code should use
     * Cloudflare's injected `window.zaraz` API at runtime.
     */
    events: defineZarazEvents,
  },
);

type ConfigResponse =
  | zaraz.GetConfigResponse
  | zaraz.PutConfigResponse
  | zaraz.GetDefaultResponse;

const toAttributes = (
  zoneId: string,
  config: ConfigResponse,
  workflow: ZarazWorkflow,
): ZarazConfig["Attributes"] => ({
  zoneId,
  dataLayer: config.dataLayer,
  debugKey: config.debugKey,
  settings: config.settings,
  tools: config.tools,
  triggers: config.triggers,
  variables: config.variables,
  zarazVersion: config.zarazVersion,
  analytics: config.analytics,
  consent: config.consent,
  historyChange: config.historyChange,
  workflow,
});

const fromAttributes = (attrs: ZarazConfigAttributes): ConfigResponse => ({
  dataLayer: attrs.dataLayer,
  debugKey: attrs.debugKey,
  settings: attrs.settings,
  tools: attrs.tools,
  triggers: attrs.triggers,
  variables: attrs.variables,
  zarazVersion: attrs.zarazVersion,
  analytics: attrs.analytics,
  consent: attrs.consent,
  historyChange: attrs.historyChange,
});

const desiredConfig = (
  observed: ConfigResponse,
  props: ZarazConfigProps,
): ConfigResponse => ({
  dataLayer: props.dataLayer ?? observed.dataLayer,
  debugKey: props.debugKey ?? observed.debugKey,
  settings: {
    ...stripNullFields(observed.settings),
    ...props.settings,
  },
  tools: props.tools ?? observed.tools,
  triggers: props.triggers ?? observed.triggers,
  variables: props.variables ?? observed.variables,
  zarazVersion: observed.zarazVersion,
  analytics:
    props.analytics ??
    (observed.analytics ? stripNullFields(observed.analytics) : undefined),
  consent:
    props.consent ??
    (observed.consent ? stripNullFields(observed.consent) : undefined),
  historyChange: props.historyChange ?? observed.historyChange,
});

const toPutConfig = (
  zoneId: string,
  config: ConfigResponse,
): zaraz.PutConfigRequest =>
  stripUndefinedFields({
    zoneId,
    dataLayer: config.dataLayer,
    debugKey: config.debugKey,
    settings: stripNullFields(config.settings) as ZarazSettings,
    tools: unwrapRedacted(config.tools) as Record<string, unknown>,
    triggers: unwrapRedacted(config.triggers) as Record<string, unknown>,
    variables: unwrapRedacted(config.variables) as Record<string, unknown>,
    zarazVersion: config.zarazVersion,
    analytics: config.analytics
      ? (stripNullFields(config.analytics) as ZarazAnalytics)
      : undefined,
    consent: config.consent
      ? (stripNullFields(config.consent) as ZarazConsent)
      : undefined,
    historyChange: config.historyChange ?? undefined,
  }) as zaraz.PutConfigRequest;

const comparableConfig = (config: ConfigResponse) => {
  const { zoneId: _, ...request } = toPutConfig("", config);
  return request;
};

const configForCompare = (
  observed: ConfigResponse,
  oldProps: ZarazConfigProps | undefined,
  props: ZarazConfigProps,
): ConfigResponse => {
  if (
    props.variables === undefined ||
    oldProps?.variables === undefined ||
    !deepEqual(oldProps.variables, props.variables)
  ) {
    return observed;
  }

  // If props already requested these variables in the previous state, compare
  // against props instead of Cloudflare's readback because secret variable
  // values are intentionally write-only in the Zaraz API.
  return {
    ...observed,
    variables: props.variables,
  };
};

export const ZarazConfigProvider = () =>
  Provider.effect(
    ZarazConfig,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const getConfig = yield* zaraz.getConfig;
      const putConfig = yield* zaraz.putConfig;
      const getDefault = yield* zaraz.getDefault;
      const getWorkflow = yield* zaraz.getWorkflow;
      // Cloudflare's OpenAPI operation name is `putZaraz`, but the endpoint
      // updates the zone's Zaraz workflow mode.
      const putWorkflow = yield* zaraz.putZaraz;

      const resolve = (zone: ZoneReference) =>
        resolveZoneId({
          accountId,
          zone,
          hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
        });

      const observe = (zoneId: string) =>
        Effect.all({
          config: getConfig({ zoneId }),
          workflow: getWorkflow({ zoneId }),
        }).pipe(
          Effect.map(({ config, workflow }) =>
            toAttributes(zoneId, config, workflow),
          ),
        );

      return {
        stables: ["zoneId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output) return undefined;
          if (!isResolved(news)) return undefined;

          const zoneId = yield* resolve(news.zone);
          if (zoneId !== output.zoneId) {
            return { action: "replace" } as const;
          }

          const outputConfig = fromAttributes(output);
          const comparableOutput = configForCompare(outputConfig, olds, news);
          const desired = desiredConfig(outputConfig, news);
          const desiredWorkflow = news.workflow ?? output.workflow;
          if (
            desiredWorkflow !== output.workflow ||
            !deepEqual(
              comparableConfig(comparableOutput),
              comparableConfig(desired),
            )
          ) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const zoneId =
            output?.zoneId ?? (olds ? yield* resolve(olds.zone) : undefined);
          if (!zoneId) return undefined;
          return yield* observe(zoneId);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
          const observed = yield* observe(zoneId);
          const observedConfig = fromAttributes(observed);
          const desired = desiredConfig(observedConfig, news);
          const desiredWorkflow = news.workflow ?? observed.workflow;

          const updatedConfig = deepEqual(
            comparableConfig(observedConfig),
            comparableConfig(desired),
          )
            ? observedConfig
            : yield* putConfig(toPutConfig(zoneId, desired));
          const updatedWorkflow =
            desiredWorkflow === observed.workflow
              ? observed.workflow
              : yield* putWorkflow({
                  zoneId,
                  workflow: desiredWorkflow,
                });

          return toAttributes(zoneId, updatedConfig, updatedWorkflow);
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          if (olds.delete !== true) return;
          const defaults = yield* getDefault({ zoneId: output.zoneId });
          yield* putConfig(toPutConfig(output.zoneId, defaults));
          if (olds.workflow !== undefined) {
            yield* putWorkflow({
              zoneId: output.zoneId,
              workflow: "realtime",
            });
          }
        }),
      };
    }),
  );
