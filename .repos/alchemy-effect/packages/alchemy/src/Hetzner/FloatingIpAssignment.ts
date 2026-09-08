import { Services } from "@distilled.cloud/hetzner";
import type { GetFloatingIpResponseFloatingIp } from "@distilled.cloud/hetzner/floating_ips";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { waitForAction } from "./actions.ts";
import { alchemyStackSelector } from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export class FloatingIpAssignmentError extends Data.TaggedError(
  "FloatingIpAssignmentError",
)<{
  message: string;
}> {}

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* FloatingIp(...)` and `FloatingIp(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Floating IP identity this assignment binds. Accepts a
 * `Hetzner.FloatingIp` resource or an `{ id }` stub.
 */
export type FloatingIpAssignmentIp = {
  readonly id: number;
};

/**
 * Server identity a Floating IP can be assigned to. Accepts a
 * `Hetzner.Server` resource or a `{ serverId }` stub.
 */
export type FloatingIpAssignmentServer = {
  readonly serverId: number;
};

export interface FloatingIpAssignmentProps {
  /**
   * Floating IP to assign. Accepts a `Hetzner.FloatingIp` or `{ id }`.
   * Changing it updates the assignment in place (previous IP is
   * unassigned).
   */
  floatingIp: Ref<FloatingIpAssignmentIp>;
  /**
   * Server to assign the Floating IP to. Accepts a `Hetzner.Server` or
   * `{ serverId }`. Changing it updates the assignment in place.
   */
  server: Ref<FloatingIpAssignmentServer>;
}

export type FloatingIpAssignment = Resource<
  "Hetzner.FloatingIpAssignment",
  FloatingIpAssignmentProps,
  {
    /**
     * Numeric Hetzner ID of the assigned Floating IP.
     */
    floatingIpId: number;
    /**
     * Numeric Hetzner ID of the Server the Floating IP is assigned to.
     */
    serverId: number;
  },
  never,
  Providers
>;

/**
 * Assigns a Hetzner Cloud {@link FloatingIp} to a Server. The assignment
 * is existence-only: observe the Floating IP and ensure it is bound to
 * the Server. Changing either reference updates in place (the previous
 * IP is unassigned, then the new pair is assigned).
 *
 * A Floating IP can be assigned to at most one Server at a time. A Server
 * may hold many Floating IPs. Destroying the assignment unassigns the IP
 * but leaves both the Floating IP and the Server in place.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#floating-ip-actions-assign-a-floating-ip-to-a-server
 *
 * ### Assigning a Floating IP
 * **Example:** Assign an IPv4 to a Server
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   image: "ubuntu-24.04",
 *   serverType: "cx23",
 *   location: "nbg1",
 * });
 * const ip = yield* Hetzner.FloatingIp("public-ip", {
 *   type: "ipv4",
 *   homeLocation: "nbg1",
 * });
 * const assignment = yield* Hetzner.FloatingIpAssignment("public-ip-web", {
 *   floatingIp: ip,
 *   server,
 * });
 * ```
 *
 * **Example:** Assign with stub identities
 * ```typescript
 * const assignment = yield* Hetzner.FloatingIpAssignment("public-ip-web", {
 *   floatingIp: { id: 123 },
 *   server: { serverId: 42 },
 * });
 * ```
 *
 * @resource
 */
export const FloatingIpAssignment = Resource<FloatingIpAssignment>(
  "Hetzner.FloatingIpAssignment",
);

type CloudFloatingIp = GetFloatingIpResponseFloatingIp;

const floatingIpIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { id?: unknown; floatingIpId?: unknown };
  if (typeof rec.id === "number") return rec.id;
  if (typeof rec.floatingIpId === "number") return rec.floatingIpId;
  return undefined;
};

const serverIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serverId?: unknown; id?: unknown };
  if (typeof rec.serverId === "number") return rec.serverId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const toAttrs = (
  ip: CloudFloatingIp,
): FloatingIpAssignment["Attributes"] | undefined => {
  if (ip.server === null) return undefined;
  return {
    floatingIpId: ip.id,
    serverId: ip.server,
  };
};

const getById = (id: number) =>
  Services.floatingIps.getFloatingIp({ id }).pipe(
    Effect.map(({ floating_ip }) => floating_ip),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const refresh = (id: number) =>
  Services.floatingIps.getFloatingIp({ id }).pipe(
    Effect.map(({ floating_ip }) => floating_ip),
    Effect.retry({
      while: (e) => e._tag === "NotFound",
      times: 5,
      schedule: Schedule.min([
        Schedule.exponential(Duration.millis(200), 1.5),
        Schedule.spaced(Duration.seconds(2)),
      ]),
    }),
  );

const observeAssignment = (floatingIpId: number, serverId: number) =>
  Effect.gen(function* () {
    const ip = yield* getById(floatingIpId);
    if (ip === undefined) return undefined;
    if (ip.server !== serverId) return undefined;
    return ip;
  });

const unassignIfNeeded = (ip: CloudFloatingIp) =>
  Effect.gen(function* () {
    if (ip.server === null) return ip;
    const { action } = yield* Services.floatingIpActions.unassignFloatingIp({
      id: ip.id,
    });
    yield* waitForAction(action);
    return yield* refresh(ip.id);
  });

const assignTo = (ip: CloudFloatingIp, serverId: number) =>
  Effect.gen(function* () {
    if (ip.server === serverId) return ip;
    const { action } = yield* Services.floatingIpActions.assignFloatingIp({
      id: ip.id,
      server: serverId,
    });
    yield* waitForAction(action);
    return yield* refresh(ip.id);
  });

export const FloatingIpAssignmentProvider = () =>
  Provider.succeed(FloatingIpAssignment, {
    stables: ["floatingIpId", "serverId"],
    nuke: { dependsOn: ["Hetzner.FloatingIp", "Hetzner.Server"] },
    list: Effect.fn(function* () {
      const items = yield* Services.floatingIps.listFloatingIps
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.flatMap((ip) => {
        const attrs = toAttrs(ip);
        return attrs === undefined ? [] : [attrs];
      });
    }),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const found = yield* observeAssignment(
        output.floatingIpId,
        output.serverId,
      );
      return found === undefined ? undefined : toAttrs(found);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const floatingIpId = floatingIpIdOf(news.floatingIp);
      const serverId = serverIdOf(news.server);
      if (floatingIpId === undefined || serverId === undefined) {
        return yield* new FloatingIpAssignmentError({
          message:
            "FloatingIpAssignment requires a resolved floatingIp and server",
        });
      }

      // Observe — cloud assignment on the Floating IP is authoritative.
      let current = yield* getById(floatingIpId);
      if (current === undefined) {
        current = yield* refresh(floatingIpId);
      }

      // Ensure — the pair exists. Release a previously owned IP first so
      // an in-place retarget does not leave the old address assigned.
      if (output !== undefined && output.floatingIpId !== floatingIpId) {
        const previous = yield* getById(output.floatingIpId);
        if (previous !== undefined && previous.server === output.serverId) {
          yield* unassignIfNeeded(previous);
        }
      }
      if (current.server !== serverId) {
        current = yield* unassignIfNeeded(current);
        current = yield* assignTo(current, serverId);
      }

      const attrs = toAttrs(current);
      if (attrs === undefined) {
        return yield* new FloatingIpAssignmentError({
          message:
            "FloatingIpAssignment reconcile finished without an assignment",
        });
      }
      return attrs;
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.floatingIpId);
      if (current === undefined) return;
      if (current.server !== output.serverId) return;
      yield* unassignIfNeeded(current);
    }),
  });
