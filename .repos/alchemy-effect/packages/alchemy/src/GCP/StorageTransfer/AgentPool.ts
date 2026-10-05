import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  agentPoolIdOf,
  agentPoolName,
  createOwnership,
  DEFAULT_AGENT_POOL,
  encodeOwnership,
  fieldMask,
  MAX_AGENT_POOL_DISPLAY_NAME,
  getAgentPool,
  hasOwnershipMarker,
  listAgentPools,
  ownedByAlchemy,
  parseOwnership,
  retryApiDisabled,
  sameValue,
  sanitizeAgentPoolId,
  toAgentPoolId,
  waitAgentPoolCreated,
  waitAgentPoolGone,
} from "./internal.ts";

export type BandwidthLimit = {
  /**
   * Bandwidth rate in megabytes per second, distributed across all
   * agents in the pool. Omit for no limit.
   */
  limitMbps?: string;
};

export type AgentPoolProps = {
  /**
   * Agent pool id (the `{agent_pool}` segment of
   * `projects/{project}/agentPools/{agent_pool}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Must match
   * `^(?!goog)[a-z]([a-z0-9-._~]*[a-z0-9])?$` and is at most 128
   * characters. Immutable — changing it replaces the pool.
   */
  agentPoolId?: string;
  /**
   * Client-specified description (combined with Alchemy ownership, max
   * 127 characters). Agent pools have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
  /**
   * Bandwidth cap for the pool. Unspecified means no limit.
   */
  bandwidthLimit?: BandwidthLimit;
};

export type AgentPool = Resource<
  "GCP.StorageTransfer.AgentPool",
  AgentPoolProps,
  {
    /** Full resource name `projects/{project}/agentPools/{agent_pool}`. */
    name: string;
    /** Agent pool id (last path segment). */
    agentPoolId: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Pool state (`CREATING`, `CREATED`, `DELETING`). */
    state: string | undefined;
    /** Configured bandwidth limit, if any. */
    bandwidthLimit: BandwidthLimit | undefined;
  },
  never,
  Providers
>;

/**
 * A Storage Transfer Service agent pool for on-premises (POSIX) agents.
 *
 * Agent pools have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Name is identity — changing
 * `agentPoolId` replaces the pool. `displayName` and `bandwidthLimit`
 * update in place.
 *
 * ### Creating an Agent Pool
 * **Example:** Generated id
 * ```typescript
 * const pool = yield* GCP.StorageTransfer.AgentPool("OnPrem", {
 *   displayName: "warehouse scanners",
 * });
 * ```
 *
 * **Example:** Named pool with a bandwidth cap
 * ```typescript
 * const pool = yield* GCP.StorageTransfer.AgentPool("OnPrem", {
 *   agentPoolId: "warehouse-scanners",
 *   displayName: "warehouse scanners",
 *   bandwidthLimit: { limitMbps: "120" },
 * });
 * ```
 *
 * ### Updating an Agent Pool
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Raise the bandwidth cap
 * ```typescript
 * const pool = yield* GCP.StorageTransfer.AgentPool("OnPrem", {
 *   displayName: "warehouse scanners",
 *   bandwidthLimit: { limitMbps: "250" },
 * });
 * ```
 *
 * @resource
 * @category StorageTransfer
 */
export const AgentPool = Resource<AgentPool>("GCP.StorageTransfer.AgentPool");

export class AgentPoolNotResolved extends Data.TaggedError(
  "GCP.StorageTransfer.AgentPoolNotResolved",
)<{
  name: string;
}> {}

const toBandwidth = (
  limit: storagetransfer.BandwidthLimit | BandwidthLimit | undefined,
): BandwidthLimit | undefined => {
  const limitMbps = limit?.limitMbps;
  if (limitMbps === undefined || limitMbps.length === 0) return undefined;
  return { limitMbps };
};

const toAttrs = (pool: storagetransfer.AgentPool, project: string) => {
  const name = pool.name ?? "";
  return {
    name,
    agentPoolId: agentPoolIdOf(name),
    project,
    displayName: parseOwnership(pool.displayName).text,
    state: pool.state,
    bandwidthLimit: toBandwidth(pool.bandwidthLimit),
  };
};

export const AgentPoolProvider = () =>
  Provider.succeed(AgentPool, {
    stables: ["name", "agentPoolId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.agentPoolId ?? output?.agentPoolId;
      if (
        previous !== undefined &&
        news.agentPoolId !== undefined &&
        sanitizeAgentPoolId(news.agentPoolId) !== previous
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agentPoolId = yield* toAgentPoolId(
        id,
        olds?.agentPoolId,
        output?.agentPoolId,
      );
      const name = output?.name ?? agentPoolName(env.project, agentPoolId);
      const existing = yield* getAgentPool(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pools = yield* listAgentPools(env.project);
        return pools
          .filter(
            (pool) =>
              agentPoolIdOf(pool.name ?? "") !== DEFAULT_AGENT_POOL &&
              hasOwnershipMarker(pool.displayName),
          )
          .map((pool) => toAttrs(pool, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const agentPoolId = yield* toAgentPoolId(
        id,
        news.agentPoolId,
        output?.agentPoolId,
      );
      const name = agentPoolName(env.project, agentPoolId);
      const ownership = yield* createOwnership(id);
      const desiredDisplayName = encodeOwnership(
        ownership,
        news.displayName,
        MAX_AGENT_POOL_DISPLAY_NAME,
      );
      const desiredLimit = toBandwidth(news.bandwidthLimit);

      let current = yield* getAgentPool(output?.name ?? name);
      if (current?.state === "DELETING") {
        yield* waitAgentPoolGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* retryApiDisabled(
          storagetransfer.createProjectsAgentPools({
            projectId: env.project,
            agentPoolId,
            body: {
              displayName: desiredDisplayName,
              bandwidthLimit: desiredLimit,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getAgentPool(name)));
        current = created ?? undefined;
      }

      if (current !== undefined && current.state === "CREATING") {
        current = (yield* waitAgentPoolCreated(name)) ?? current;
      }

      if (current === undefined) {
        return yield* new AgentPoolNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== desiredDisplayName;
      const limitChanged = !sameValue(
        toBandwidth(current.bandwidthLimit),
        desiredLimit,
      );
      const updateMask = fieldMask([
        displayChanged ? "display_name" : undefined,
        limitChanged ? "bandwidth_limit" : undefined,
      ]);

      if (updateMask.length > 0) {
        current = yield* storagetransfer.patchProjectsAgentPools({
          name: current.name ?? name,
          updateMask,
          body: {
            displayName: desiredDisplayName,
            bandwidthLimit: desiredLimit,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.agentPoolId === DEFAULT_AGENT_POOL) return;
      yield* storagetransfer
        .deleteProjectsAgentPools({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.exponential("500 millis"),
          }),
        );
    }),
  });
