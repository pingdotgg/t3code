import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ApiShield.Label" as const;
type TypeId = typeof TypeId;

export interface LabelProps {
  /**
   * Zone the label is defined on.
   *
   * Immutable — moving a label between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Name of the label. Must be 1–24 characters. If omitted, a unique
   * lowercase name is generated from the app, stage, and logical ID.
   *
   * Immutable — the name is the label's identity, so changing it triggers
   * a replacement.
   * @default ${app}-${id}-${stage}-${suffix} (truncated to 24 characters)
   */
  name?: string;
  /**
   * Human-readable description of the label. Mutable — patched in place.
   * @default ""
   */
  description?: string;
}

export interface LabelAttributes {
  /** Zone the label is defined on. */
  zoneId: string;
  /** Name of the label (its identity within the zone). */
  name: string;
  /** Human-readable description of the label. */
  description: string;
  /**
   * Who owns the label: `user` for labels we manage, `managed` for
   * Cloudflare-curated labels.
   */
  source: string;
  /** ISO8601 creation timestamp. */
  createdAt: string;
  /** ISO8601 timestamp of the last update. */
  lastUpdated: string;
}

/**
 * Returns true if the given value is an Label resource.
 */
export const isLabel = (value: unknown): value is Label =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export type Label = Resource<
  TypeId,
  LabelProps,
  LabelAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare API Shield user label — a zone-scoped tag that can be
 * attached to registered API operations to organize and filter them
 * (e.g. by team, service, or sensitivity).
 *
 * The label's `name` is its identity (and Cloudflare limits it to 24
 * characters), so renaming triggers a replacement; only the `description`
 * is mutable in place. Deleting a label detaches it from any operations
 * server-side.
 * @resource
 * @product API Shield
 * @category Application Security
 * @section Creating a Label
 * @example Label with a generated name
 * ```typescript
 * const label = yield* Cloudflare.ApiShield.Label("TeamPayments", {
 *   zoneId: zone.zoneId,
 *   description: "endpoints owned by the payments team",
 * });
 * ```
 *
 * @example Label with an explicit name
 * ```typescript
 * yield* Cloudflare.ApiShield.Label("Pii", {
 *   zoneId: zone.zoneId,
 *   name: "pii",
 *   description: "endpoints that return personal data",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/management-and-monitoring/endpoint-labels/
 */
export const Label = Resource<Label>(TypeId);

export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["zoneId", "name", "source", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Labels are zone-scoped — fan out over every zone and list its
      // user labels. Only `user`-sourced labels are enumerated;
      // `managed` labels are Cloudflare-curated and not ours to delete.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          apiGateway.listLabels.pages({ zoneId: zone.id, source: "user" }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((label) =>
                  toAttributes(label, zone.id),
                ),
              ),
            ),
            // A zone may genuinely vanish mid-enumeration: a concurrent
            // delete purged it (ZonePurged, Cloudflare code 10410), it lacks
            // the route (InvalidRoute), or it's already gone (NotFound). Skip
            // that zone rather than fail the whole enumeration. (Transient
            // code-10000 "Authentication error" blips under concurrency are
            // retried globally by the Cloudflare retry policy, so they never
            // reach here as a real failure.)
            Effect.catchTag(["ZonePurged", "InvalidRoute", "NotFound"], () =>
              Effect.succeed([]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const o = olds as LabelProps | undefined;
      const n = news as LabelProps;
      if (o === undefined) return undefined;
      // The name is the label's identity — compare the resolved physical
      // names (an omitted name resolves deterministically from the id).
      const oldName = output?.name ?? (yield* createLabelName(id, o.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const newName = n.name ?? oldName;
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both are concrete.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by the persisted name.
      if (output?.name) {
        const observed = yield* getLabel(zoneId, output.name);
        return observed ? toAttributes(observed, zoneId) : undefined;
      }

      // Cold path: recover from lost state via the deterministic name.
      // Labels carry no ownership markers, so an existing label is
      // reported as `Unowned` and adoption is gated by the adopt policy.
      const name = yield* createLabelName(id, olds?.name);
      const observed = yield* getLabel(zoneId, name);
      return observed ? Unowned(toAttributes(observed, zoneId)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const name = output?.name ?? (yield* createLabelName(id, news.name));

      // 1. Observe — read the live label; the attributes cached on
      //    `output` are a hint, not a guarantee.
      let observed = yield* getLabel(zoneId, name);

      // 2. Ensure — create when missing. A concurrent create surfaces as
      //    `LabelAlreadyExists` (Cloudflare code 70009): converge by
      //    re-reading the label that won the race.
      if (!observed) {
        observed = yield* apiGateway
          .bulkCreateLabelUsers({
            zoneId,
            body: [{ name, description: news.description }],
          })
          .pipe(
            Effect.map((response) => response.result[0]),
            Effect.catchTag("LabelAlreadyExists", (error) =>
              getLabel(zoneId, name).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(existing) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      // 3. Sync — diff the observed description against desired; skip the
      //    patch call entirely on a no-op.
      const desired = news.description ?? "";
      if (observed.description !== desired) {
        observed = yield* apiGateway.patchLabelUser({
          zoneId,
          name,
          description: desired,
        });
      }

      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apiGateway
        .deleteLabelUser({ zoneId: output.zoneId, name: output.name })
        .pipe(Effect.catchTag("LabelNotFound", () => Effect.void));
    }),
  });

type ObservedLabel = Pick<
  apiGateway.GetLabelUserResponse,
  "name" | "description" | "source" | "createdAt" | "lastUpdated"
>;

/**
 * Read a label by name, mapping "gone" (`LabelNotFound`, Cloudflare error
 * code 70014) to `undefined`.
 */
const getLabel = (zoneId: string, name: string) =>
  apiGateway.getLabelUser({ zoneId, name }).pipe(
    Effect.map((label): ObservedLabel | undefined => label),
    Effect.catchTag("LabelNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Resolve the label's physical name: the explicit prop wins; otherwise a
 * deterministic name is generated from the app, stage, and logical ID,
 * truncated to Cloudflare's 24-character limit.
 */
const createLabelName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({
        id,
        lowercase: true,
        maxLength: 24,
        suffixLength: 8,
      }))
    );
  });

const toAttributes = (
  label: ObservedLabel,
  zoneId: string,
): LabelAttributes => ({
  zoneId,
  name: label.name,
  description: label.description,
  source: label.source,
  createdAt: label.createdAt,
  lastUpdated: label.lastUpdated,
});
