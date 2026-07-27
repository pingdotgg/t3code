import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createInternalTags,
  hasAlchemyTags,
  stripInternalTags,
} from "../Tags.ts";
import { Docker, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface NetworkProps {
  /**
   * Docker network name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Network driver. @default "bridge" */
  driver?: "bridge" | "host" | "none" | "overlay" | "macvlan" | (string & {});
  /** Enable IPv6 on the network. @default false */
  enableIPv6?: boolean;
  /** Network labels. */
  labels?: Record<string, string>;
}

export interface Network extends Resource<
  "Docker.Network",
  NetworkProps,
  {
    /** Docker network ID. */
    id: string;
    /** Docker network name. */
    name: string;
    /** Network driver. */
    driver: string;
    /** Whether IPv6 is enabled. */
    enableIPv6: boolean;
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
  },
  never,
  Providers
> {}

/**
 * A Docker network managed through the active Docker context.
 *
 * Existing same-name networks are treated as foreign unless the engine is
 * explicitly allowed to adopt them with `--adopt` or `adopt(true)`.
 *
 * @resource
 *
 * @section Creating Networks
 * @example Basic bridge network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "app-network",
 * });
 * ```
 *
 * @section Adoption
 * @example Adopt a pre-existing network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "shared-app-network",
 * }).pipe(adopt(true));
 * ```
 */
export const Network = Resource<Network>("Docker.Network");

export const NetworkProvider = () =>
  Provider.effect(
    Network,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return Network.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* docker.network
            .inspect(name)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
          if (!info) return undefined;
          const attrs = toNetworkAttributes(info);
          if (output) return attrs;
          // Without prior state, only adopt a network that carries our branding;
          // anything else is foreign and gated behind `--adopt`.
          const owned = yield* hasAlchemyTags(id, info.Labels ?? undefined);
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, output, instanceId, news }) {
          if (!isResolved(news) || !output) return undefined;
          const args = yield* makeNetworkArgs(id, news, instanceId);
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const desiredName = news?.name ?? output.name;
          if (
            output.name !== desiredName ||
            output.driver !== args.driver ||
            output.enableIPv6 !== args.ipv6 ||
            // Compare only user labels; internal `alchemy::*` branding lives on
            // the observed network but must not drive replacement.
            !Equal.equals(stripInternalTags(output.labels), args.label ?? {})
          ) {
            return { action: "replace", deleteFirst: true };
          }
        }),
        reconcile: Effect.fn(function* ({ output, id, instanceId, news }) {
          if (output) {
            const refreshed = yield* docker.network.inspect(output.id).pipe(
              Effect.map(toNetworkAttributes),
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
            if (refreshed) return refreshed;
          }
          const args = yield* makeNetworkArgs(id, news, instanceId);
          const internalTags = yield* createInternalTags(id);
          const { stdout: createdId } = yield* docker.network.create({
            ...args,
            label: { ...internalTags, ...args.label },
          });
          return toNetworkAttributes(yield* docker.network.inspect(createdId));
        }),
        delete: Effect.fn(({ output }) =>
          docker.network
            .remove(output.id)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const makeNetworkArgs = (
  id: string,
  props: NetworkProps | undefined,
  instanceId: string,
) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.map(
      (name): Parameters<Docker["Service"]["network"]["create"]>[0] => ({
        name,
        driver: props?.driver ?? "bridge",
        ipv6: props?.enableIPv6 ?? false,
        label: props?.labels ?? {},
      }),
    ),
  );

export const toNetworkAttributes = (
  info: Docker.Network,
): Network["Attributes"] => ({
  id: info.Id,
  name: info.Name,
  driver: info.Driver,
  enableIPv6: info.EnableIPv6,
  labels: info.Labels ?? {},
  createdAt: Date.parse(info.Created) || Date.now(),
});
