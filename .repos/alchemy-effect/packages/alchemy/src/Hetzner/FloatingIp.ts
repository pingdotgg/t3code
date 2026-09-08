import { Services } from "@distilled.cloud/hetzner";
import type { GetFloatingIpResponseFloatingIp } from "@distilled.cloud/hetzner/floating_ips";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction } from "./actions.ts";
import { findLocation } from "./Catalog.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export type FloatingIpType = "ipv4" | "ipv6";

export interface FloatingIpProps {
  /**
   * Address family of the Floating IP. Cannot be changed after creation —
   * changing it triggers a replacement.
   */
  type: FloatingIpType;
  /**
   * Home Location for the Floating IP (`nbg1`, `fsn1`, `hel1`, …) or the
   * Location's numeric id. Routing is optimized for this Location. Cannot
   * be changed after creation — changing it triggers a replacement.
   */
  homeLocation: string | number;
  /**
   * Name of the Floating IP. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from the stack, stage, and
   * logical ID.
   */
  name?: string;
  /**
   * Free-form description shown in the Hetzner Cloud Console.
   */
  description?: string | null;
  /**
   * User-defined labels (`key`/`value` pairs) applied to the Floating IP.
   * Alchemy ownership labels are added automatically.
   */
  labels?: Record<string, string>;
  /**
   * Prevent the Floating IP from being deleted via the API.
   * @default false
   */
  deleteProtection?: boolean;
}

export type FloatingIp = Resource<
  "Hetzner.FloatingIp",
  FloatingIpProps,
  {
    /**
     * Numeric Hetzner ID of the Floating IP.
     */
    id: number;
    /**
     * Name of the Floating IP.
     */
    name: string;
    /**
     * Address family of the Floating IP.
     */
    type: FloatingIpType;
    /**
     * Assigned address. For `ipv6` this is the `/64` network.
     */
    ip: string;
    /**
     * Home Location name (`nbg1`, `fsn1`, …).
     */
    homeLocation: string;
    /**
     * Numeric ID of the home Location.
     */
    homeLocationId: number;
    /**
     * Description of the Floating IP, or `null` if unset.
     */
    description: string | null;
    /**
     * Whether Hetzner has blocked the Floating IP.
     */
    blocked: boolean;
    /**
     * Whether delete protection is enabled.
     */
    deleteProtection: boolean;
    /**
     * User-defined labels (Alchemy ownership labels are stripped).
     */
    labels: Record<string, string>;
    /**
     * RFC3339 timestamp when the Floating IP was created.
     */
    created: string;
    /**
     * Numeric Server ID this Floating IP is assigned to, or `null` if
     * unassigned. Assignment is managed by `FloatingIpAssignment`.
     */
    serverId: number | null;
  },
  never,
  Providers
>;

/**
 * An unassigned Hetzner Cloud Floating IP. Provide `type` and a
 * `homeLocation`; Alchemy generates a unique name unless you set `name`.
 * Assignment to a Server is a separate `FloatingIpAssignment` resource.
 *
 * `type` and `homeLocation` are immutable — changing either replaces the
 * Floating IP (new address). `name`, `description`, `labels`, and
 * `deleteProtection` update in place.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#floating-ips
 *
 * ### Creating a Floating IP
 * **Example:** Unassigned IPv4 in nbg1
 * ```typescript
 * const ip = yield* Hetzner.FloatingIp("public-ip", {
 *   type: "ipv4",
 *   homeLocation: "nbg1",
 * });
 * ```
 *
 * **Example:** IPv6 with description and labels
 * ```typescript
 * const ip = yield* Hetzner.FloatingIp("v6", {
 *   type: "ipv6",
 *   homeLocation: "nbg1",
 *   description: "edge anycast",
 *   labels: { role: "edge" },
 * });
 * ```
 *
 * ### Updating a Floating IP
 * **Example:** Rename and relabel
 * ```typescript
 * const ip = yield* Hetzner.FloatingIp("public-ip", {
 *   type: "ipv4",
 *   homeLocation: "nbg1",
 *   name: "public-ip-prod",
 *   description: "production frontend",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 */
export const FloatingIp = Resource<FloatingIp>("Hetzner.FloatingIp");

type CloudFloatingIp = GetFloatingIpResponseFloatingIp;

const asType = (type: string): FloatingIpType =>
  type === "ipv6" ? "ipv6" : "ipv4";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (ip: CloudFloatingIp): FloatingIp["Attributes"] => ({
  id: ip.id,
  name: ip.name,
  type: asType(ip.type),
  ip: ip.ip,
  homeLocation: ip.home_location.name,
  homeLocationId: ip.home_location.id,
  description: ip.description,
  blocked: ip.blocked,
  deleteProtection: ip.protection.delete,
  labels: userLabels(ip.labels),
  created: ip.created,
  serverId: ip.server,
});

const createFloatingIpName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      name ?? existing ?? (yield* createPhysicalName({ id, maxLength: 63 }))
    );
  });

const getById = (id: number) =>
  Services.floatingIps.getFloatingIp({ id }).pipe(
    Effect.map(({ floating_ip }) => floating_ip),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByName = (name: string) =>
  Services.floatingIps
    .listFloatingIps({ name, per_page: 50 })
    .pipe(Effect.map(({ floating_ips }) => floating_ips[0]));

const getByLabels = (labels: Record<string, string>) =>
  Services.floatingIps
    .listFloatingIps({
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ floating_ips }) => floating_ips[0]));

const observe = Effect.fn(function* ({
  id,
  name,
  outputId,
}: {
  id: string;
  name?: string;
  outputId?: number;
}) {
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  if (name !== undefined) {
    const byName = yield* getByName(name);
    if (byName !== undefined) return byName;
  }
  const internal = yield* createInternalLabels(id);
  return yield* getByLabels(internal);
});

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

const sameHomeLocation = (
  desired: string | number,
  attrs: Pick<FloatingIp["Attributes"], "homeLocation" | "homeLocationId">,
): boolean =>
  desired === attrs.homeLocation ||
  desired === attrs.homeLocationId ||
  String(desired) === String(attrs.homeLocationId);

const matchesDesired = (
  ip: CloudFloatingIp,
  type: FloatingIpType,
  location: { name: string; id: number },
): boolean =>
  asType(ip.type) === type &&
  sameHomeLocation(location.name, {
    homeLocation: ip.home_location.name,
    homeLocationId: ip.home_location.id,
  });

const disableProtection = (id: number) =>
  Services.floatingIpActions
    .changeFloatingIpProtection({ id, delete: false })
    .pipe(Effect.flatMap(({ action }) => waitForAction(action)));

export class FloatingIpNotCreated extends Data.TaggedError(
  "Hetzner.FloatingIpNotCreated",
)<{
  name: string;
}> {}

export const FloatingIpProvider = () =>
  Provider.succeed(FloatingIp, {
    stables: ["id", "ip", "type", "homeLocation", "homeLocationId", "created"],
    nuke: { dependsOn: ["Hetzner.Server"] },
    list: Effect.fn(function* () {
      const items = yield* Services.floatingIps.listFloatingIps
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map(toAttrs);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        if (news.type !== output.type) {
          return { action: "replace" } as const;
        }
        if (!sameHomeLocation(news.homeLocation, output)) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const found = yield* observe({
        id,
        name: olds?.name ?? output?.name,
        outputId: output?.id,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found);
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const location = yield* findLocation(news.homeLocation);
      const name = yield* createFloatingIpName(id, news.name, output?.name);
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const desiredDescription = news.description ?? null;
      const desiredProtection = news.deleteProtection ?? false;

      // Observe — cloud state is authoritative. `output.id` is a cache
      // for the stable identifier; if the IP is gone, we recreate.
      let current: CloudFloatingIp | undefined = yield* observe({
        id,
        name,
        outputId: output?.id,
      });
      // A previous generation found via ownership labels (same logical id,
      // different type/location) is the resource being replaced — do not
      // take it over; create a new Floating IP instead.
      if (
        current !== undefined &&
        current.id !== output?.id &&
        !matchesDesired(current, news.type, location)
      ) {
        current = undefined;
      }

      // Ensure — create only when missing. A Conflict is a race with a
      // peer reconciler or a name that just became visible; re-observe.
      if (current === undefined) {
        const created = yield* Services.floatingIps
          .createFloatingIp({
            type: news.type,
            home_location: location.name,
            name,
            description: desiredDescription,
            labels: desiredLabels,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          if (created.action) {
            yield* waitForAction(created.action);
          }
          current = created.floating_ip;
        } else {
          const hit = yield* observe({ id, name });
          if (hit !== undefined && matchesDesired(hit, news.type, location)) {
            current = hit;
          }
        }
      }

      if (current === undefined) {
        return yield* new FloatingIpNotCreated({ name });
      }

      // Sync — name / description / labels via PUT (labels overwrite the
      // full set). Protection is a separate Action.
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const needsUpdate =
        current.name !== name ||
        (current.description ?? null) !== desiredDescription ||
        upsert.length > 0 ||
        removed.length > 0;
      if (needsUpdate) {
        const updated = yield* Services.floatingIps.updateFloatingIp({
          id: current.id,
          name,
          description: desiredDescription,
          labels: desiredLabels,
        });
        current = updated.floating_ip;
      }

      if (current.protection.delete !== desiredProtection) {
        const { action } =
          yield* Services.floatingIpActions.changeFloatingIpProtection({
            id: current.id,
            delete: desiredProtection,
          });
        yield* waitForAction(action);
      }

      return toAttrs(yield* refresh(current.id));
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current === undefined) return;
      if (current.protection.delete) {
        yield* disableProtection(current.id);
      }
      if (current.server !== null) {
        const { action } = yield* Services.floatingIpActions.unassignFloatingIp(
          { id: current.id },
        );
        yield* waitForAction(action);
      }
      yield* Services.floatingIps
        .deleteFloatingIp({ id: current.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
