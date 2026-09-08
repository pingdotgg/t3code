import { Services } from "@distilled.cloud/hetzner";
import type { GetPrimaryIpResponsePrimaryIp } from "@distilled.cloud/hetzner/primary_ips";
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
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export type PrimaryIpType = "ipv4" | "ipv6";

export interface PrimaryIpProps {
  /**
   * Address family. Cannot be changed after creation — changing it
   * triggers a replacement.
   */
  type: PrimaryIpType;
  /**
   * Location name (`nbg1`, `fsn1`, `hel1`, …) or numeric Location ID.
   * Required unless `datacenter` is set. Cannot be changed after
   * creation — changing it triggers a replacement.
   */
  location?: string | number;
  /**
   * Datacenter name (`nbg1-dc3`, `fsn1-dc14`, …) or numeric Datacenter
   * ID. Alternative to `location`; a name is mapped onto the parent
   * Location (`nbg1-dc3` → `nbg1`). Cannot be changed after creation —
   * changing it triggers a replacement.
   */
  datacenter?: string | number;
  /**
   * Name of the Primary IP. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from the stack, stage, and
   * logical ID.
   */
  name?: string;
  /**
   * If enabled, Hetzner deletes this Primary IP when its assigned
   * resource is deleted.
   * @default false
   */
  autoDelete?: boolean;
  /**
   * User-defined labels (`key`/`value` pairs) applied to the Primary IP.
   * Alchemy ownership labels are added automatically.
   */
  labels?: Record<string, string>;
  /**
   * Prevent the Primary IP from being deleted via the API.
   * @default false
   */
  deleteProtection?: boolean;
}

export type PrimaryIp = Resource<
  "Hetzner.PrimaryIp",
  PrimaryIpProps,
  {
    /**
     * Numeric Hetzner ID of the Primary IP.
     */
    id: number;
    /**
     * Name of the Primary IP.
     */
    name: string;
    /**
     * Address family of the Primary IP.
     */
    type: PrimaryIpType;
    /**
     * Assigned address. For `ipv6` this is the `/64` network.
     */
    ip: string;
    /**
     * Location name the IP is bound to (`nbg1`, `fsn1`, …).
     */
    location: string;
    /**
     * Numeric Location id.
     */
    locationId: number;
    /**
     * Datacenter name or id from props, when the resource was placed via
     * `datacenter`. Not returned by the API.
     */
    datacenter: string | undefined;
    /**
     * Whether Hetzner has blocked the Primary IP.
     */
    blocked: boolean;
    /**
     * Auto-delete flag.
     */
    autoDelete: boolean;
    /**
     * Assigned resource id, or `null` if unassigned.
     */
    assigneeId: number | null;
    /**
     * Assigned resource type (`server`), when assigned.
     */
    assigneeType: string | undefined;
    /**
     * RFC3339 timestamp when the Primary IP was created.
     */
    created: string;
    /**
     * User-defined labels (Alchemy ownership labels are stripped).
     */
    labels: Record<string, string>;
    /**
     * Whether delete protection is enabled.
     */
    deleteProtection: boolean;
  },
  never,
  Providers
>;

/**
 * An unassigned Hetzner Cloud Primary IP. Provide `type` and either a
 * `location` or a `datacenter`; Alchemy generates a unique name unless
 * you set `name`. Assignee wiring is a later resource.
 *
 * `type`, `location`, and `datacenter` are immutable — changing any of
 * them replaces the Primary IP (new address). `name`, `autoDelete`,
 * `labels`, and `deleteProtection` update in place.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#primary-ips
 *
 * ### Creating a Primary IP
 * **Example:** IPv6 in Nuremberg
 * ```typescript
 * const ip = yield* Hetzner.PrimaryIp("web-ipv6", {
 *   type: "ipv6",
 *   location: "nbg1",
 * });
 * ```
 *
 * **Example:** IPv4 placed by datacenter
 * ```typescript
 * const ip = yield* Hetzner.PrimaryIp("web-ipv4", {
 *   type: "ipv4",
 *   datacenter: "nbg1-dc3",
 * });
 * ```
 *
 * ### Labels and auto-delete
 * **Example:** Named IP with labels
 * ```typescript
 * const ip = yield* Hetzner.PrimaryIp("mail", {
 *   name: "mail-ipv4",
 *   type: "ipv4",
 *   location: "fsn1",
 *   autoDelete: false,
 *   labels: { role: "mail" },
 * });
 * ```
 *
 * @resource
 */
export const PrimaryIp = Resource<PrimaryIp>("Hetzner.PrimaryIp");

export class PrimaryIpPlacementRequired extends Data.TaggedError(
  "Hetzner.PrimaryIpPlacementRequired",
)<{
  message: string;
}> {}

type CloudPrimaryIp = GetPrimaryIpResponsePrimaryIp;

const asType = (type: string): PrimaryIpType =>
  type === "ipv6" ? "ipv6" : "ipv4";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

/**
 * Hetzner datacenter names are `{location}-dc{n}` (e.g. `nbg1-dc3`).
 * Numeric ids are passed through — Locations use a different id space.
 */
export const locationFromDatacenter = (
  datacenter: string | number,
): string | number => {
  if (typeof datacenter === "number") return datacenter;
  const match = /^([a-z0-9]+)-dc\d+$/i.exec(datacenter);
  return match ? match[1]!.toLowerCase() : datacenter;
};

const resolvePlacement = (
  props: Pick<PrimaryIpProps, "location" | "datacenter">,
): string | number | undefined => {
  if (props.location !== undefined) return props.location;
  if (props.datacenter !== undefined) {
    return locationFromDatacenter(props.datacenter);
  }
  return undefined;
};

const samePlacement = (
  news: Pick<PrimaryIpProps, "location" | "datacenter">,
  attrs: PrimaryIp["Attributes"],
): boolean => {
  const desired = resolvePlacement(news);
  if (desired === undefined) return true;
  return (
    desired === attrs.location ||
    desired === attrs.locationId ||
    String(desired) === String(attrs.locationId)
  );
};

const toAttrs = (
  ip: CloudPrimaryIp,
  extras?: { datacenter?: string | number },
): PrimaryIp["Attributes"] => ({
  id: ip.id,
  name: ip.name,
  type: asType(ip.type),
  ip: ip.ip,
  location: ip.location.name,
  locationId: ip.location.id,
  datacenter:
    extras?.datacenter !== undefined ? String(extras.datacenter) : undefined,
  blocked: ip.blocked,
  autoDelete: ip.auto_delete,
  assigneeId: ip.assignee_id,
  assigneeType: ip.assignee_type,
  created: ip.created,
  labels: userLabels(ip.labels),
  deleteProtection: ip.protection.delete,
});

const createPrimaryIpName = (
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
  Services.primaryIps.getPrimaryIp({ id }).pipe(
    Effect.map(({ primary_ip }) => primary_ip),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByName = (name: string) =>
  Services.primaryIps
    .listPrimaryIps({ name, per_page: 50 })
    .pipe(Effect.map(({ primary_ips }) => primary_ips[0]));

const observe = Effect.fn(function* ({
  name,
  outputId,
}: {
  id: string;
  name?: string;
  outputId?: number;
}) {
  // Identity is the numeric id (cached on `output`) or the unique
  // project-scoped name. Do NOT fall back to alchemy.* labels: a
  // replacement shares the logical id with the old generation, so a
  // label lookup would adopt the IP we are replacing.
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  if (name !== undefined) {
    return yield* getByName(name);
  }
  return undefined;
});

const refresh = (id: number) =>
  Services.primaryIps.getPrimaryIp({ id }).pipe(
    Effect.map(({ primary_ip }) => primary_ip),
    Effect.retry({
      while: (e) => e._tag === "NotFound",
      times: 5,
      schedule: Schedule.min([
        Schedule.exponential(Duration.millis(200), 1.5),
        Schedule.spaced(Duration.seconds(2)),
      ]),
    }),
  );

const disableProtection = (id: number) =>
  Services.primaryIpActions
    .changePrimaryIpProtection({ id, delete: false })
    .pipe(Effect.flatMap(({ action }) => waitForAction(action)));

export const PrimaryIpProvider = () =>
  Provider.succeed(PrimaryIp, {
    stables: ["id", "ip", "type", "location", "locationId", "created"],
    nuke: { dependsOn: ["Hetzner.Server"] },
    list: Effect.fn(function* () {
      const items = yield* Services.primaryIps.listPrimaryIps
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map((ip) => toAttrs(ip));
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        if (news.type !== output.type) {
          return { action: "replace" } as const;
        }
        if (!samePlacement(news, output)) {
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
      const attrs = toAttrs(found, {
        datacenter: olds?.datacenter ?? output?.datacenter,
      });
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createPrimaryIpName(id, news.name, output?.name);
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const desiredAutoDelete = news.autoDelete ?? false;
      const desiredProtection = news.deleteProtection ?? false;

      // Observe — cloud state is authoritative. `output.id` is a cache
      // for the stable identifier; if the IP is gone, we recreate.
      let current = yield* observe({
        id,
        name,
        outputId: output?.id,
      });

      // Ensure — create only when missing. A Conflict is a race with a
      // peer reconciler or a name that just became visible; re-observe.
      if (current === undefined) {
        const placement = resolvePlacement(news);
        if (placement === undefined) {
          return yield* new PrimaryIpPlacementRequired({
            message:
              "PrimaryIp requires `location` or `datacenter` when creating",
          });
        }
        const location = yield* findLocation(placement);
        const created = yield* Services.primaryIps
          .createPrimaryIp({
            name,
            type: news.type,
            location: location.name,
            labels: desiredLabels,
            auto_delete: desiredAutoDelete,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              observe({ id, name }).pipe(
                Effect.flatMap((hit) =>
                  hit !== undefined
                    ? Effect.succeed({ primary_ip: hit, action: undefined })
                    : Services.primaryIps.createPrimaryIp({
                        name,
                        type: news.type,
                        location: location.name,
                        labels: desiredLabels,
                        auto_delete: desiredAutoDelete,
                      }),
                ),
              ),
            ),
          );
        if (created.action) {
          yield* waitForAction(created.action);
        }
        current = created.primary_ip;
      }

      // Sync — name / auto_delete / labels via PUT (labels overwrite the
      // full set). Protection is a separate Action.
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const needsUpdate =
        current.name !== name ||
        current.auto_delete !== desiredAutoDelete ||
        upsert.length > 0 ||
        removed.length > 0;
      if (needsUpdate) {
        const updated = yield* Services.primaryIps.updatePrimaryIp({
          id: current.id,
          name,
          auto_delete: desiredAutoDelete,
          labels: desiredLabels,
        });
        current = updated.primary_ip;
      }

      if (current.protection.delete !== desiredProtection) {
        const { action } =
          yield* Services.primaryIpActions.changePrimaryIpProtection({
            id: current.id,
            delete: desiredProtection,
          });
        yield* waitForAction(action);
      }

      return toAttrs(yield* refresh(current.id), {
        datacenter: news.datacenter,
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current === undefined) return;
      if (current.protection.delete) {
        yield* disableProtection(current.id);
      }
      if (current.assignee_id !== null) {
        const { action } = yield* Services.primaryIpActions.unassignPrimaryIp({
          id: current.id,
        });
        yield* waitForAction(action);
      }
      yield* Services.primaryIps
        .deletePrimaryIp({ id: current.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
