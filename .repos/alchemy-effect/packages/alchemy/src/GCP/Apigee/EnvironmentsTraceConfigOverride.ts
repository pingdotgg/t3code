import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  organizationIdOf,
  parseOrgEnv,
  sameText,
} from "./common.ts";

export type TraceSamplingConfig = {
  /**
   * Sampler. `OFF` is the default; `PROBABILITY` uses `samplingRate`.
   */
  sampler?:
    | apigee.GoogleCloudApigeeV1TraceSamplingConfigSamplerEnum
    | (string & {});
  /**
   * Sampling rate when using `PROBABILITY`. Must be `> 0` and `<= 0.5`.
   */
  samplingRate?: number;
};

export type EnvironmentsTraceConfigOverrideProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the override.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the override.
   */
  environment: string;
  /**
   * API proxy whose trace configuration is overridden.
   */
  apiProxy: string;
  /**
   * Trace sampling configuration to apply.
   */
  samplingConfig?: TraceSamplingConfig;
};

export type EnvironmentsTraceConfigOverride = Resource<
  "GCP.Apigee.EnvironmentsTraceConfigOverride",
  EnvironmentsTraceConfigOverrideProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/traceConfig/overrides/{id}`. */
    name: string;
    /** System-generated override id (UUID). */
    traceConfigOverrideId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** API proxy id. */
    apiProxy: string;
    /** Sampling configuration. */
    samplingConfig: TraceSamplingConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A distributed-trace configuration override for one API proxy in an
 * Apigee environment.
 *
 * Overrides have no labels; `list` enumerates every override in Apigee
 * environments mapped to this GCP project. The override id is assigned by
 * Apigee. Organization and environment are identity; `apiProxy` and
 * `samplingConfig` update in place.
 *
 * ### Creating an Override
 * **Example:** Probability sampler
 * ```typescript
 * const override = yield* GCP.Apigee.EnvironmentsTraceConfigOverride("ProxyTrace", {
 *   environment: "eval",
 *   apiProxy: "hello",
 *   samplingConfig: { sampler: "PROBABILITY", samplingRate: 0.1 },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsTraceConfigOverride =
  Resource<EnvironmentsTraceConfigOverride>(
    "GCP.Apigee.EnvironmentsTraceConfigOverride",
  );

export class EnvironmentsTraceConfigOverrideNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsTraceConfigOverrideNotResolved",
)<{
  name: string;
}> {}

const traceConfigParent = (organizationId: string, environmentId: string) =>
  `${environmentNameOf(organizationId, environmentId)}/traceConfig`;

const samplingOf = (
  config: apigee.GoogleCloudApigeeV1TraceSamplingConfig | undefined,
): TraceSamplingConfig | undefined => {
  if (config === undefined) return undefined;
  return { sampler: config.sampler, samplingRate: config.samplingRate };
};

const toAttrs = (
  override: apigee.GoogleCloudApigeeV1TraceConfigOverride,
  organizationId: string,
  environmentId: string,
) => {
  const raw = override.name ?? "";
  const parsed = parseOrgEnv(raw);
  return {
    name: raw.includes("/")
      ? raw
      : `${traceConfigParent(organizationId, environmentId)}/overrides/${raw}`,
    traceConfigOverrideId: lastSegment(raw),
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    apiProxy: override.apiProxy ?? "",
    samplingConfig: samplingOf(override.samplingConfig),
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsTraceConfigOverrides({ name }),
  );

const listOverrides = (parent: string) =>
  apigee.listOrganizationsEnvironmentsTraceConfigOverrides
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.traceConfigOverrides ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1TraceConfigOverride[]),
      ),
    );

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

export const EnvironmentsTraceConfigOverrideProvider = () =>
  Provider.succeed(EnvironmentsTraceConfigOverride, {
    stables: [
      "name",
      "traceConfigOverrideId",
      "organizationId",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (orgChanged || envChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(
        olds?.organization ?? output?.organizationId,
        project,
      );
      const environmentId = environmentIdOf(
        olds?.environment ?? output?.environmentId ?? "",
      );
      if (output?.name) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        return toAttrs(existing, organizationId, environmentId);
      }
      const listed = yield* listOverrides(
        traceConfigParent(organizationId, environmentId),
      );
      const match = listed.find(
        (item) => item.apiProxy === (olds?.apiProxy ?? ""),
      );
      if (match === undefined) return undefined;
      return toAttrs(match, organizationId, environmentId);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsTraceConfigOverride["Attributes"][] = [];
        for (const item of environments) {
          const listed = yield* listOverrides(
            traceConfigParent(item.organizationId, item.environmentId),
          );
          for (const override of listed) {
            found.push(
              toAttrs(override, item.organizationId, item.environmentId),
            );
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const parent = traceConfigParent(organizationId, environmentId);

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;
      if (current === undefined) {
        const listed = yield* listOverrides(parent);
        current = listed.find((item) => item.apiProxy === news.apiProxy);
      }

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsTraceConfigOverrides({
            parent,
            body: {
              apiProxy: news.apiProxy,
              samplingConfig: news.samplingConfig,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listOverrides(parent).pipe(
                Effect.map((items) =>
                  items.find((item) => item.apiProxy === news.apiProxy),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.name) {
        return yield* new EnvironmentsTraceConfigOverrideNotResolved({
          name: `${parent}/overrides`,
        });
      }

      const proxyChanged = !sameText(current.apiProxy, news.apiProxy);
      const samplingChanged =
        jsonOf(samplingOf(current.samplingConfig)) !==
        jsonOf(news.samplingConfig);
      if (proxyChanged || samplingChanged) {
        current =
          yield* apigee.patchOrganizationsEnvironmentsTraceConfigOverrides({
            name: current.name,
            updateMask: [
              proxyChanged ? "api_proxy" : undefined,
              samplingChanged ? "sampling_config" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              apiProxy: news.apiProxy,
              samplingConfig: news.samplingConfig,
            },
          });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsTraceConfigOverrides({
          name: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
