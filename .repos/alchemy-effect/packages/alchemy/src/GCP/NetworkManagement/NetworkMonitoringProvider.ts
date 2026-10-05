import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { alchemyLabelKeys, createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName as qualifiedName,
  rfc1035,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "networkMonitoringProviders";
const DEFAULT_PROVIDER_TYPE =
  "EXTERNAL" satisfies networkmanagement.NetworkMonitoringProviderProviderTypeEnum;

export type NetworkMonitoringProviderType =
  | networkmanagement.NetworkMonitoringProviderProviderTypeEnum
  | (string & {});

export type NetworkMonitoringProviderProps = {
  /**
   * Provider id (the `{network_monitoring_provider}` segment of
   * `projects/{project}/locations/{location}/networkMonitoringProviders/{network_monitoring_provider}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the provider.
   */
  networkMonitoringProviderId?: string;
  /**
   * Location. Network monitoring providers are only served from `global`
   * (regional names are rejected as malformed). Immutable — changing it
   * replaces the provider.
   * @default "global"
   */
  location?: string;
  /**
   * Provider type. The API currently supports `EXTERNAL`. Immutable —
   * changing it replaces the provider.
   * @default "EXTERNAL"
   */
  providerType?: NetworkMonitoringProviderType;
};

export type NetworkMonitoringProvider = Resource<
  "GCP.NetworkManagement.NetworkMonitoringProvider",
  NetworkMonitoringProviderProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/networkMonitoringProviders/{network_monitoring_provider}`. */
    name: string;
    /** Provider id (last path segment). */
    networkMonitoringProviderId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Provider type (`EXTERNAL`). */
    providerType: string | undefined;
    /** Link to the provider UI. */
    providerUri: string | undefined;
    /** Provider state (`ACTIVATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** Server-reported error messages. */
    errors: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Intelligence Center Network Monitoring Provider.
 *
 * The API has no labels, description, or patch method. Identity is the
 * id, location, and provider type; changing any of them replaces the
 * provider. Alchemy stamps ownership into the generated id so `list` /
 * nuke can find leaked rows.
 *
 * ### Creating a NetworkMonitoringProvider
 * **Example:** External provider
 * ```typescript
 * const provider = yield* GCP.NetworkManagement.NetworkMonitoringProvider(
 *   "AppNeta",
 *   { providerType: "EXTERNAL" },
 * );
 * ```
 *
 * **Example:** Named provider
 * ```typescript
 * const provider = yield* GCP.NetworkManagement.NetworkMonitoringProvider(
 *   "AppNeta",
 *   {
 *     networkMonitoringProviderId: "app-neta",
 *     location: "global",
 *     providerType: "EXTERNAL",
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkManagement
 */
export const NetworkMonitoringProvider = Resource<NetworkMonitoringProvider>(
  "GCP.NetworkManagement.NetworkMonitoringProvider",
);

const resourceName = (
  project: string,
  location: string,
  networkMonitoringProviderId: string,
) => qualifiedName(project, location, COLLECTION, networkMonitoringProviderId);

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_PROVIDER_TYPE).toUpperCase();

const ownedPrefix = (labels: Record<string, string>) => {
  const id = (labels[alchemyLabelKeys.id] ?? "x")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 8);
  return `alch${id.length > 0 ? id : "x"}`;
};

const GLOBAL_LOCATION = "global";

const isOwnedId = (id: string) => id.toLowerCase().startsWith("alch");

const toOwnedId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) {
      return rfc1035(explicit, "nmp");
    }
    if (existing !== undefined) return existing;
    const labels = yield* createInternalLabels(id);
    const generated = yield* toPhysicalId(id, undefined, undefined, "nmp");
    const prefix = ownedPrefix(labels);
    if (generated.startsWith(prefix)) return generated;
    return rfc1035(`${prefix}-${generated}`, "nmp");
  });

const toAttrs = (
  provider: networkmanagement.NetworkMonitoringProvider,
  project: string,
  region: string,
) => {
  const name = provider.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    networkMonitoringProviderId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    providerType: provider.providerType,
    providerUri: provider.providerUri,
    state: provider.state,
    errors: provider.errors ?? [],
    createTime: provider.createTime,
    updateTime: provider.updateTime,
  };
};

const getByName = (name: string) =>
  networkmanagement
    .getProjectsLocationsNetworkMonitoringProviders({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NetworkMonitoringProviderProvider = () =>
  Provider.succeed(NetworkMonitoringProvider, {
    stables: [
      "name",
      "networkMonitoringProviderId",
      "project",
      "location",
      "providerType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.networkMonitoringProviderId ??
        output?.networkMonitoringProviderId;
      const nextId = news.networkMonitoringProviderId
        ? rfc1035(news.networkMonitoringProviderId, "nmp")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        GLOBAL_LOCATION,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        GLOBAL_LOCATION,
      );
      const previousType = typeOf(olds?.providerType ?? output?.providerType);
      const nextType = typeOf(
        news.providerType ?? olds?.providerType ?? output?.providerType,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousType !== nextType
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkMonitoringProviderId = yield* toOwnedId(
        id,
        olds?.networkMonitoringProviderId,
        output?.networkMonitoringProviderId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        GLOBAL_LOCATION,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, networkMonitoringProviderId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, GLOBAL_LOCATION);
      return isOwnedId(attrs.networkMonitoringProviderId) ||
        olds?.networkMonitoringProviderId !== undefined ||
        output?.networkMonitoringProviderId !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const listed: NetworkMonitoringProvider["Attributes"][] = [];
        const seen = new Set<string>();
        const parents = [
          parentOf(env.project, "-"),
          ...[GLOBAL_LOCATION].map((location) =>
            parentOf(env.project, location),
          ),
        ];
        for (const parent of parents) {
          const items = yield* collectPages(
            networkmanagement.listProjectsLocationsNetworkMonitoringProviders.pages(
              {
                parent,
                pageSize: 1000,
              },
            ),
            (page) => page.networkMonitoringProviders,
          );
          for (const item of items) {
            const attrs = toAttrs(item, env.project, GLOBAL_LOCATION);
            if (!isOwnedId(attrs.networkMonitoringProviderId)) continue;
            if (seen.has(attrs.name)) continue;
            seen.add(attrs.name);
            listed.push(attrs);
          }
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkMonitoringProviderId = yield* toOwnedId(
        id,
        news.networkMonitoringProviderId,
        output?.networkMonitoringProviderId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        GLOBAL_LOCATION,
      );
      const name = resourceName(
        env.project,
        location,
        networkMonitoringProviderId,
      );
      const providerType = typeOf(news.providerType);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkmanagement
          .createProjectsLocationsNetworkMonitoringProviders({
            parent: parentOf(env.project, location),
            networkMonitoringProviderId,
            body: { providerType },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
      );

      return toAttrs(current, env.project, GLOBAL_LOCATION);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkmanagement
        .deleteProjectsLocationsNetworkMonitoringProviders({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
