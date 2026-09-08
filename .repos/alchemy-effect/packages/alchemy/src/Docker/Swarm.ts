import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker, dockerContextName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface SwarmProps {
  /** Docker context name or context resource of the engine to initialize. */
  context?: Docker.ContextRef;
  /**
   * Address advertised to other swarm members, e.g. `"10.0.0.1"` or
   * `"eth0"`. Required by Docker when the host has several network
   * interfaces. Applied only when the swarm is first initialized.
   */
  advertiseAddr?: string;
  /**
   * Listen address for swarm traffic, e.g. `"0.0.0.0:2377"`. Applied only
   * when the swarm is first initialized.
   */
  listenAddr?: string;
  /**
   * Address pools for global-scope (overlay) networks, e.g.
   * `["10.20.0.0/16"]`. Applied only when the swarm is first initialized.
   */
  defaultAddrPool?: string[];
  /**
   * CIDR mask length for each subnet carved from `defaultAddrPool`.
   * Applied only when the swarm is first initialized.
   *
   * @default 24
   */
  subnetSize?: number;
}

export interface Swarm extends Resource<
  "Docker.Swarm",
  SwarmProps,
  {
    /** Swarm cluster id. */
    id: string;
    /** This node's id in the swarm (a manager). */
    nodeId: string;
    /** Docker context the swarm was initialized on. */
    context?: string;
    /** Number of manager nodes. */
    managers: number;
    /** Number of nodes in the swarm. */
    nodes: number;
  },
  never,
  Providers
> {}

/**
 * Swarm mode on a Docker engine — an idempotent `docker swarm init`.
 *
 * Turns the engine behind the given `context` (or the local engine) into a
 * single-node swarm: the node becomes a manager that can run `Docker.Service`
 * workloads. Regular (non-swarm) docker usage of the engine is unaffected.
 *
 * Pass the swarm as the `context` of a `Docker.Service` or overlay
 * `Docker.Network`: the workload then deploys after the swarm exists and
 * inherits its Docker context.
 *
 * An engine that is already in swarm mode is treated as foreign — adopt it
 * with `adopt(true)` (or `--adopt`) to manage it. Destroying the resource
 * dissolves the node's swarm membership (`docker swarm leave --force`),
 * which stops every service running on it — services managed by the same
 * stack are destroyed first via their dependency edges.
 *
 * Growing the cluster beyond one node is host-level setup: run
 * `docker swarm join --token <token> <manager-ip>:2377` on each additional
 * machine (`docker swarm join-token worker` on the manager prints the
 * command). Alchemy manages the swarm's workloads through the manager.
 * ### Creating a Swarm
 * **Example:** Local single-node swarm
 * ```typescript
 * const swarm = yield* Docker.Swarm("swarm");
 * ```
 *
 * **Example:** Remote engine over SSH
 * ```typescript
 * const vps = yield* Docker.Context("vps", {
 *   docker: "host=ssh://deploy@example.com",
 * });
 * const swarm = yield* Docker.Swarm("swarm", {
 *   context: vps,
 *   advertiseAddr: "10.0.0.1",
 * });
 * ```
 *
 * ### Using an Existing Swarm
 * **Example:** Reference without owning
 * ```typescript
 * // Services don't require a Swarm resource — point them at an engine that
 * // is already a manager and the swarm's lifecycle stays external: destroy
 * // removes the services, never the swarm.
 * const web = yield* Docker.Service("web", {
 *   context: vps,
 *   image: "nginx:alpine",
 * });
 * ```
 *
 * **Example:** Adopt an already-initialized engine
 * ```typescript
 * // Adoption makes the swarm part of the stack — destroy then dissolves
 * // the node's membership.
 * const swarm = yield* Docker.Swarm("swarm").pipe(adopt(true));
 * ```
 *
 * ### Deploying into the Swarm
 * **Example:** Service ordered after the swarm
 * ```typescript
 * const swarm = yield* Docker.Swarm("swarm");
 * const web = yield* Docker.Service("web", {
 *   context: swarm,
 *   image: "nginx:alpine",
 *   replicas: 2,
 *   ports: [{ external: 8080, internal: 80 }],
 * });
 * ```
 *
 * @resource
 */
export const Swarm = Resource<Swarm>("Docker.Swarm");

export const SwarmProvider = () =>
  Provider.effect(
    Swarm,
    Effect.gen(function* () {
      const docker = yield* Docker;

      /** Active-manager info, or undefined when the engine isn't one. */
      const observe = Effect.fn(function* (context: string | undefined) {
        const info = yield* docker.swarm.info(context);
        if (
          info.LocalNodeState !== "active" ||
          !info.ControlAvailable ||
          !info.Cluster?.ID
        ) {
          return undefined;
        }
        return info;
      });

      return Swarm.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const context = dockerContextName(olds?.context);
          const info = yield* observe(context);
          if (!info) return undefined;
          const attrs = toSwarmAttributes(info, context);
          if (output) return attrs;
          // A swarm carries no labels to brand, so an already-initialized
          // engine can never be proven ours — adoption is gated behind
          // `--adopt` / `adopt(true)`.
          return Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            dockerContextName(olds?.context) !==
            dockerContextName(news?.context)
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          // The remaining props only apply at `swarm init`; changing them on
          // a live swarm is a no-op rather than a destructive re-init.
          return { action: "noop" as const };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const context = dockerContextName(news?.context);
          const existing = yield* observe(context);
          if (existing) return toSwarmAttributes(existing, context);

          yield* docker.swarm
            .init({
              context,
              "advertise-addr": news?.advertiseAddr,
              "listen-addr": news?.listenAddr,
              "default-addr-pool": news?.defaultAddrPool,
              "default-addr-pool-mask-length": news?.subnetSize,
            })
            .pipe(
              // A concurrent init (or an interrupted prior reconcile) already
              // made this node a swarm member — converge on the observation.
              Effect.catchIf(
                (error) => /already part of a swarm/i.test(String(error)),
                () => Effect.void,
              ),
            );

          const info = yield* observe(context);
          if (!info) {
            return yield* Effect.die(
              new Error(
                "docker swarm init succeeded but the engine did not become an active swarm manager",
              ),
            );
          }
          return toSwarmAttributes(info, context);
        }),
        delete: Effect.fn(({ output }) =>
          docker.swarm.leave(true, output.context).pipe(
            Effect.catchIf(
              (error) => /not part of a swarm/i.test(String(error)),
              () => Effect.void,
            ),
            Effect.asVoid,
          ),
        ),
      });
    }),
  );

const toSwarmAttributes = (
  info: Docker.SwarmInfo,
  context: string | undefined,
): Swarm["Attributes"] => ({
  id: info.Cluster!.ID,
  nodeId: info.NodeID,
  context,
  managers: info.Managers ?? 1,
  nodes: info.Nodes ?? 1,
});
