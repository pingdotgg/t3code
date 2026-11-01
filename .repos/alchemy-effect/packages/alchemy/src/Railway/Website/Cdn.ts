import { Query } from "@distilled.cloud/core/query";
import {
  Railway,
  type EdgeConfig,
  type PurgeOnDeploy,
  type UpdateServiceEdgeConfigInput,
} from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type CdnService = {
  readonly serviceId: string;
};

export type CdnEnvironment = {
  readonly environmentId: string;
};

export interface CdnProps {
  /**
   * Parent Railway Service whose domains receive CDN caching.
   */
  service: Ref<CdnService>;
  /**
   * Environment the Service instance lives in.
   */
  environment: Ref<CdnEnvironment>;
  /**
   * HTML caching mode. `"AUTO"` caches HTML only when the origin sends
   * `max-age` / `s-maxage`. `"FORCE"` uses the default TTL. `"NEVER"`
   * skips HTML.
   * @default "AUTO"
   */
  htmlCaching?: "AUTO" | "FORCE" | "NEVER" | (string & {});
  /**
   * What to purge after a successful deploy.
   * @default "HTML"
   */
  purgeOnDeploy?: PurgeOnDeploy;
  /**
   * Fallback TTL in seconds when the origin sends no freshness.
   * @default 7200
   */
  defaultTtlSeconds?: number;
}

export interface Cdn extends Resource<
  "Railway.Website.Cdn",
  CdnProps,
  {
    serviceId: string;
    environmentId: string;
    edgeConfigId: string;
    enabled: boolean;
  },
  never,
  Providers
> {}

/**
 * Enable Railway's built-in CDN on a Website Service. Static assets
 * (by Content-Type) are cached at the edge; HTML follows
 * {@link CdnProps.htmlCaching}.
 *
 * @resource
 */
export const Cdn = Resource<Cdn>("Railway.Website.Cdn");

export class CdnServiceMissing extends Data.TaggedError(
  "Railway.Website.CdnServiceMissing",
)<{
  message: string;
}> {}

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  return typeof rec.serviceId === "string" && rec.serviceId.length > 0
    ? rec.serviceId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const cachingInput = (props: CdnProps) => ({
  htmlCaching: (props.htmlCaching ?? "AUTO").toLowerCase(),
  purgeOnDeploy: props.purgeOnDeploy ?? "HTML",
  defaultTtlSeconds: props.defaultTtlSeconds ?? 7200,
});

const edgeConfigFields = <E>(config: Query<EdgeConfig, E>) => ({
  id: config.id,
  enabled: config.enabled,
  caching: config.caching.pipe(
    Query.map((caching) => ({
      mode: caching.mode,
      htmlCaching: caching.htmlCaching,
      purgeOnDeploy: caching.purgeOnDeploy,
      defaultTtlSeconds: caching.defaultTtlSeconds,
    })),
  ),
});

const readEdgeConfig = Query.fn((serviceId: string, environmentId: string) =>
  Railway.serviceInstance({ serviceId, environmentId }).edgeConfig.pipe(
    Query.map(edgeConfigFields),
  ),
);

const readEdgeConfigAndDomains = Query.fn(
  (serviceId: string, environmentId: string) => {
    const instance = Railway.serviceInstance({ serviceId, environmentId });
    return {
      edgeConfig: instance.edgeConfig.pipe(Query.map(edgeConfigFields)),
      domains: {
        serviceDomains: instance.domains.serviceDomains.pipe(
          Query.map((domain) => ({ syncStatus: domain.syncStatus })),
        ),
        customDomains: instance.domains.customDomains.pipe(
          Query.map((domain) => ({ syncStatus: domain.syncStatus })),
        ),
      },
    };
  },
);

const enableServiceCdn = Query.fn((serviceId: string, environmentId: string) =>
  edgeConfigFields(
    Railway.enableServiceCdn({ input: { environmentId, serviceId } }),
  ),
);

const updateServiceEdgeConfig = Query.fn(
  (input: UpdateServiceEdgeConfigInput) => ({
    id: Railway.updateServiceEdgeConfig({ input }).id,
  }),
);

const disableServiceCdn = Query.fn((serviceId: string, environmentId: string) =>
  Railway.disableServiceCdn({ input: { environmentId, serviceId } }),
);

export class CdnPublicDomainPending extends Data.TaggedError(
  "Railway.Website.CdnPublicDomainPending",
)<{ serviceId: string; environmentId: string }> {}

export class CdnConfigurationPending extends Data.TaggedError(
  "Railway.Website.CdnConfigurationPending",
)<{ serviceId: string; environmentId: string }> {}

const getConfig = (serviceId: string, environmentId: string) =>
  readEdgeConfig(serviceId, environmentId).pipe(
    Effect.map((edgeConfig) => edgeConfig ?? undefined),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
  );

const getReadyConfig = (serviceId: string, environmentId: string) =>
  readEdgeConfigAndDomains(serviceId, environmentId).pipe(
    Effect.flatMap((instance) =>
      [
        ...instance.domains.serviceDomains,
        ...instance.domains.customDomains,
      ].some(
        (domain) =>
          domain.syncStatus === "ACTIVE" || domain.syncStatus === "UNSPECIFIED",
      )
        ? Effect.succeed(instance.edgeConfig ?? undefined)
        : Effect.fail(new CdnPublicDomainPending({ serviceId, environmentId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.Website.CdnPublicDomainPending",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const CdnProvider = () =>
  Provider.succeed(Cdn, {
    stables: ["serviceId", "environmentId", "edgeConfigId"],
    nuke: { dependsOn: ["Railway.Service"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news) || output === undefined) {
        return undefined;
      }
      const serviceId = serviceIdOf(news.service);
      const environmentId = environmentIdOf(news.environment);
      if (
        (serviceId !== undefined && serviceId !== output.serviceId) ||
        (environmentId !== undefined && environmentId !== output.environmentId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    list: () => Effect.succeed([]),

    read: Effect.fn(function* ({ olds, output }) {
      const serviceId = output?.serviceId ?? serviceIdOf(olds?.service);
      const environmentId =
        output?.environmentId ?? environmentIdOf(olds?.environment);
      if (serviceId === undefined || environmentId === undefined)
        return undefined;
      const current = yield* getConfig(serviceId, environmentId);
      return current === undefined
        ? undefined
        : {
            serviceId,
            environmentId,
            edgeConfigId: current.id,
            enabled:
              current.enabled &&
              current.caching != null &&
              current.caching.mode.toLowerCase() !== "off",
          };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const serviceId = serviceIdOf(news.service) ?? output?.serviceId ?? "";
      const environmentId =
        environmentIdOf(news.environment) ?? output?.environmentId ?? "";
      if (serviceId.length === 0 || environmentId.length === 0) {
        return yield* new CdnServiceMissing({
          message: "Railway.Website.Cdn requires a Service and environment.",
        });
      }
      const config = { caching: cachingInput(news) };
      let current = yield* getReadyConfig(serviceId, environmentId);
      if (
        current?.enabled !== true ||
        current.caching == null ||
        current.caching.mode.toLowerCase() === "off"
      ) {
        current = yield* enableServiceCdn(serviceId, environmentId);
      }
      const caching = current?.caching;
      const changed =
        caching?.htmlCaching !== config.caching.htmlCaching ||
        caching?.purgeOnDeploy !== config.caching.purgeOnDeploy ||
        caching?.defaultTtlSeconds !== config.caching.defaultTtlSeconds;
      if (changed) {
        yield* updateServiceEdgeConfig({ serviceId, environmentId, config });
      }
      const enabled = yield* getConfig(serviceId, environmentId).pipe(
        Effect.flatMap((observed) =>
          observed?.enabled === true &&
          observed.caching != null &&
          observed.caching.mode.toLowerCase() !== "off" &&
          observed.caching.htmlCaching === config.caching.htmlCaching &&
          observed.caching.purgeOnDeploy === config.caching.purgeOnDeploy &&
          observed.caching.defaultTtlSeconds ===
            config.caching.defaultTtlSeconds
            ? Effect.succeed(observed)
            : Effect.fail(
                new CdnConfigurationPending({ serviceId, environmentId }),
              ),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "Railway.Website.CdnConfigurationPending",
          times: 8,
          schedule: Schedule.spaced("1 second"),
        }),
      );
      return {
        serviceId,
        environmentId,
        edgeConfigId: enabled.id,
        enabled: enabled.enabled,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      const current = yield* getConfig(output.serviceId, output.environmentId);
      if (current === undefined || !current.enabled) return;
      yield* disableServiceCdn(output.serviceId, output.environmentId);
    }),
  });
