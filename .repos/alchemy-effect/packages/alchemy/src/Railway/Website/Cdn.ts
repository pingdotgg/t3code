import type { PurgeOnDeploy } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { isRailwayTransient } from "../transient.ts";

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
  htmlCaching: props.htmlCaching ?? "AUTO",
  purgeOnDeploy: props.purgeOnDeploy ?? "HTML",
  defaultTtlSeconds: props.defaultTtlSeconds ?? 7200,
});

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

    read: Effect.fn(function* ({ output }) {
      return output;
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
      const retryTransient = {
        while: (e: { _tag: string }) =>
          e._tag === "RailwayInternalError" ||
          e._tag === "TimeoutError" ||
          isRailwayTransient(e),
        times: 2 as const,
        schedule: Schedule.spaced("1 second"),
      };
      const enabled = yield* railway
        .enableServiceCdn({
          input: {
            environmentId,
            serviceId,
            config,
          },
        })
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.retry(retryTransient),
          Effect.catchTag("UnknownRailwayError", () =>
            railway
              .updateServiceEdgeConfig({
                input: {
                  serviceId,
                  environmentId,
                  config,
                },
              })
              .pipe(Effect.timeout("5 seconds"), Effect.retry(retryTransient)),
          ),
          Effect.catchTag(["TimeoutError", "RailwayInternalError"], () =>
            Effect.succeed({
              id: output?.edgeConfigId ?? "",
              enabled: output?.enabled ?? false,
            }),
          ),
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
      if (output.edgeConfigId.length === 0) return;
      yield* railway
        .disableServiceCdn({
          input: {
            environmentId: output.environmentId,
            serviceId: output.serviceId,
          },
        })
        .pipe(
          Effect.catchTag(
            ["UnknownRailwayError", "RailwayValidationError"],
            () => Effect.void,
          ),
        );
    }),
  });
