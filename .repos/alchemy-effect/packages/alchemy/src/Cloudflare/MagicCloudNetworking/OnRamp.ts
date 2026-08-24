import * as mcn from "@distilled.cloud/cloudflare/magic-cloud-networking";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MagicCloudNetworking.OnRamp" as const;
type TypeId = typeof TypeId;

/**
 * The cloud provider an on-ramp connects to Magic WAN.
 */
export type OnRampCloudType = "AWS" | "AZURE" | "GOOGLE";

/**
 * Topology of an on-ramp: a single VPC/VNet, or a hub (e.g. AWS Transit
 * Gateway) with attached VPCs.
 */
export type OnRampType = "OnrampTypeSingle" | "OnrampTypeHub";

export interface OnRampProps {
  /**
   * The cloud provider this on-ramp connects to.
   *
   * Immutable — changing the cloud type triggers a replacement.
   */
  cloudType: OnRampCloudType;
  /**
   * Topology of the on-ramp: `OnrampTypeSingle` connects one VPC/VNet,
   * `OnrampTypeHub` provisions a hub (e.g. AWS Transit Gateway) that VPCs
   * attach to.
   *
   * Immutable — changing the topology triggers a replacement.
   */
  type: OnRampType;
  /**
   * Enables BGP routing. When enabled, set both `installRoutesInCloud` and
   * `installRoutesInMagicWan` to `false`.
   *
   * Immutable — the API offers no way to change it, so a change triggers a
   * replacement.
   */
  dynamicRouting: boolean;
  /**
   * Whether Cloudflare installs Magic WAN routes into the cloud route
   * tables. Mutable.
   */
  installRoutesInCloud: boolean;
  /**
   * Whether routes to the cloud networks are installed in Magic WAN.
   * Mutable.
   */
  installRoutesInMagicWan: boolean;
  /**
   * Human readable name. Used as the on-ramp's identity for cold-state
   * recovery, so it should be unique within the account. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Cloud region the on-ramp is provisioned in (e.g. `us-east-1`).
   *
   * Immutable — changing the region triggers a replacement.
   */
  region?: string;
  /**
   * The discovered VPC/VNet resource id to connect
   * (`type: "OnrampTypeSingle"`). Mutable.
   */
  vpc?: string;
  /**
   * Cloud-side ASN for BGP. If unset or zero, the cloud's default ASN
   * takes effect.
   *
   * Immutable — the API offers no way to change it, so a change triggers a
   * replacement.
   */
  cloudAsn?: number;
  /**
   * Free-form description of the on-ramp. Mutable.
   */
  description?: string;
  /**
   * Adopt an existing hub (e.g. an existing Transit Gateway) instead of
   * provisioning one (`type: "OnrampTypeHub"`).
   *
   * Immutable — hub identity cannot change, so a change triggers a
   * replacement.
   */
  adoptedHubId?: string;
  /**
   * Cloud integration that owns the hub when it lives in a different
   * provider account.
   *
   * Immutable — hub identity cannot change, so a change triggers a
   * replacement.
   */
  hubProviderId?: string;
  /**
   * Hubs attached to this on-ramp. Mutable.
   */
  attachedHubs?: string[];
  /**
   * VPCs attached to this hub on-ramp (`type: "OnrampTypeHub"`). Mutable.
   */
  attachedVpcs?: string[];
  /**
   * Whether Cloudflare manages hub-to-hub attachments. Mutable.
   */
  manageHubToHubAttachments?: boolean;
  /**
   * Whether Cloudflare manages VPC-to-hub attachments. Mutable.
   */
  manageVpcToHubAttachments?: boolean;
  /**
   * Whether deleting the on-ramp also destroys the cloud-side resources it
   * provisioned (VPN gateways, Transit Gateway, …). Consumed only at
   * delete time.
   * @default false
   */
  destroyOnDelete?: boolean;
}

export interface OnRampAttributes {
  /** Cloudflare-assigned identifier of the on-ramp. */
  onRampId: string;
  /** The Cloudflare account the on-ramp belongs to. */
  accountId: string;
  /** Human readable name of the on-ramp. */
  name: string;
  /** The cloud provider this on-ramp connects to. */
  cloudType: OnRampCloudType;
  /** Topology of the on-ramp. */
  type: OnRampType;
  /** Whether BGP routing is enabled. */
  dynamicRouting: boolean;
  /** Whether Magic WAN routes are installed into the cloud route tables. */
  installRoutesInCloud: boolean;
  /** Whether cloud routes are installed in Magic WAN. */
  installRoutesInMagicWan: boolean;
  /** The connected VPC/VNet resource id, if set. */
  vpc: string | undefined;
  /** Cloud-side ASN, if set. */
  cloudAsn: number | undefined;
  /** Free-form description, if set. */
  description: string | undefined;
  /** Hubs attached to this on-ramp. */
  attachedHubs: string[];
  /** VPCs attached to this hub on-ramp. */
  attachedVpcs: string[];
  /** Whether Cloudflare manages hub-to-hub attachments, if reported. */
  manageHubToHubAttachments: boolean | undefined;
  /** Whether Cloudflare manages VPC-to-hub attachments, if reported. */
  manageVpcToHubAttachments: boolean | undefined;
  /** ISO8601 timestamp of the last change to the on-ramp. */
  updatedAt: string;
  /** Whether delete also destroys provisioned cloud-side resources. */
  destroyOnDelete: boolean;
}

export type OnRamp = Resource<
  TypeId,
  OnRampProps,
  OnRampAttributes,
  never,
  Providers
>;

/**
 * A Magic Cloud Networking on-ramp — connects cloud VPCs/VNets to Magic WAN
 * by provisioning VPN/Transit-Gateway constructs inside the cloud account
 * registered via a `CloudIntegration`.
 *
 * On-ramps are heavily eventually consistent: after create/update the
 * on-ramp goes through plan/apply phases that provision real cloud
 * infrastructure (minutes). This resource creates and patches the on-ramp
 * configuration and returns immediately; the apply lifecycle is driven by
 * Cloudflare.
 *
 * `name`, `description`, `vpc`, route-installation flags, and attachments
 * are patched in place; `cloudType`, `type`, `dynamicRouting`, `region`,
 * `cloudAsn`, and hub identity force a replacement.
 *
 * Magic Cloud Networking is an entitlement-gated add-on (Magic WAN family).
 * On accounts without the entitlement every API call fails with the typed
 * `FeatureNotEnabled` error (Cloudflare code 1012, "feature not enabled").
 * @resource
 * @product Magic Cloud Networking
 * @category Network
 * @section Connecting a single VPC
 * @example AWS VPC on-ramp
 * ```typescript
 * const onramp = yield* Cloudflare.MagicCloudNetworking.OnRamp("ProdVpc", {
 *   cloudType: "AWS",
 *   type: "OnrampTypeSingle",
 *   region: "us-east-1",
 *   vpc: discoveredVpcId,
 *   dynamicRouting: false,
 *   installRoutesInCloud: true,
 *   installRoutesInMagicWan: true,
 * });
 * ```
 *
 * @section Hub topologies
 * @example Transit Gateway hub with attached VPCs
 * ```typescript
 * yield* Cloudflare.MagicCloudNetworking.OnRamp("TgwHub", {
 *   cloudType: "AWS",
 *   type: "OnrampTypeHub",
 *   region: "us-east-1",
 *   dynamicRouting: true,
 *   installRoutesInCloud: false,
 *   installRoutesInMagicWan: false,
 *   attachedVpcs: [vpcA, vpcB],
 *   manageVpcToHubAttachments: true,
 * });
 * ```
 *
 * @section Destroy behavior
 * @example Tear down cloud-side resources on destroy
 * ```typescript
 * yield* Cloudflare.MagicCloudNetworking.OnRamp("ProdVpc", {
 *   cloudType: "AWS",
 *   type: "OnrampTypeSingle",
 *   region: "us-east-1",
 *   vpc: discoveredVpcId,
 *   dynamicRouting: false,
 *   installRoutesInCloud: true,
 *   installRoutesInMagicWan: true,
 *   destroyOnDelete: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-cloud-networking/
 */
export const OnRamp = Resource<OnRamp>(TypeId);

/**
 * Returns true if the given value is an OnRamp resource.
 */
export const isOnRamp = (value: unknown): value is OnRamp =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const OnRampProvider = () =>
  Provider.succeed(OnRamp, {
    stables: [
      "onRampId",
      "accountId",
      "cloudType",
      "type",
      "dynamicRouting",
      "cloudAsn",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const old = olds !== undefined && isResolved(olds) ? olds : undefined;
      // Immutable identity/topology properties — the PATCH body accepts
      // none of these, so any change is a replacement.
      const oldCloudType = output?.cloudType ?? old?.cloudType;
      if (oldCloudType !== undefined && oldCloudType !== news.cloudType) {
        return { action: "replace" } as const;
      }
      const oldType = output?.type ?? old?.type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      const oldDynamicRouting = output?.dynamicRouting ?? old?.dynamicRouting;
      if (
        oldDynamicRouting !== undefined &&
        oldDynamicRouting !== news.dynamicRouting
      ) {
        return { action: "replace" } as const;
      }
      if (old !== undefined) {
        if (old.region !== news.region) {
          return { action: "replace" } as const;
        }
        if (old.cloudAsn !== news.cloudAsn) {
          return { action: "replace" } as const;
        }
        if (old.adoptedHubId !== news.adoptedHubId) {
          return { action: "replace" } as const;
        }
        if (old.hubProviderId !== news.hubProviderId) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const destroyOnDelete =
        output?.destroyOnDelete ?? olds?.destroyOnDelete ?? false;

      // Owned path: refresh by our persisted on-ramp id.
      if (output?.onRampId) {
        const observed = yield* getOnRamp(acct, output.onRampId);
        if (observed) return toAttributes(observed, acct, destroyOnDelete);
        return undefined;
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name. On-ramps carry no ownership markers, so report a
      // match as Unowned and let the engine gate adoption.
      const name = yield* onRampName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match
        ? Unowned(toAttributes(match, acct, destroyOnDelete))
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* onRampName(id, news.name);
      const destroyOnDelete = news.destroyOnDelete ?? false;

      // 1. Observe — the id cached on `output` is a hint, not a guarantee:
      //    a missing on-ramp falls through to the name scan and create.
      let observed = output?.onRampId
        ? yield* getOnRamp(output.accountId ?? accountId, output.onRampId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create when missing. Names are not unique on
      //    Cloudflare's side so there is no AlreadyExists race to tolerate.
      if (!observed) {
        observed = yield* mcn.createOnRamp({
          accountId,
          name,
          cloudType: news.cloudType,
          type: news.type,
          dynamicRouting: news.dynamicRouting,
          installRoutesInCloud: news.installRoutesInCloud,
          installRoutesInMagicWan: news.installRoutesInMagicWan,
          region: news.region,
          vpc: news.vpc,
          cloudAsn: news.cloudAsn,
          description: news.description,
          adoptedHubId: news.adoptedHubId,
          hubProviderId: news.hubProviderId,
          attachedHubs: news.attachedHubs,
          attachedVpcs: news.attachedVpcs,
          manageHubToHubAttachments: news.manageHubToHubAttachments,
          manageVpcToHubAttachments: news.manageVpcToHubAttachments,
        });
        return toAttributes(observed, accountId, destroyOnDelete);
      }

      // 3. Sync — diff observed cloud state against desired; PATCH only the
      //    delta and skip the call entirely on a no-op.
      const patch: mcn.PatchOnRampRequest = {
        accountId,
        onrampId: observed.id,
      };
      let dirty = false;
      if (observed.name !== name) {
        patch.name = name;
        dirty = true;
      }
      if (
        news.description !== undefined &&
        (observed.description ?? "") !== news.description
      ) {
        patch.description = news.description;
        dirty = true;
      }
      if (news.vpc !== undefined && (observed.vpc ?? "") !== news.vpc) {
        patch.vpc = news.vpc;
        dirty = true;
      }
      if (observed.installRoutesInCloud !== news.installRoutesInCloud) {
        patch.installRoutesInCloud = news.installRoutesInCloud;
        dirty = true;
      }
      if (observed.installRoutesInMagicWan !== news.installRoutesInMagicWan) {
        patch.installRoutesInMagicWan = news.installRoutesInMagicWan;
        dirty = true;
      }
      if (
        news.attachedHubs !== undefined &&
        !sameIds(observed.attachedHubs ?? [], news.attachedHubs)
      ) {
        patch.attachedHubs = news.attachedHubs;
        dirty = true;
      }
      if (
        news.attachedVpcs !== undefined &&
        !sameIds(observed.attachedVpcs ?? [], news.attachedVpcs)
      ) {
        patch.attachedVpcs = news.attachedVpcs;
        dirty = true;
      }
      if (
        news.manageHubToHubAttachments !== undefined &&
        (observed.manageHubToHubAttachments ?? false) !==
          news.manageHubToHubAttachments
      ) {
        patch.manageHubToHubAttachments = news.manageHubToHubAttachments;
        dirty = true;
      }
      if (
        news.manageVpcToHubAttachments !== undefined &&
        (observed.manageVpcToHubAttachments ?? false) !==
          news.manageVpcToHubAttachments
      ) {
        patch.manageVpcToHubAttachments = news.manageVpcToHubAttachments;
        dirty = true;
      }
      if (dirty) {
        observed = yield* mcn.patchOnRamp(patch);
      }

      return toAttributes(observed, accountId, destroyOnDelete);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting an on-ramp tears down cloud-side infrastructure when
      // `destroy` is set — slow and eventually consistent on Cloudflare's
      // side, but the DELETE call itself returns promptly.
      yield* mcn
        .deleteOnRamp({
          accountId: output.accountId,
          onrampId: output.onRampId,
          destroy: output.destroyOnDelete,
        })
        .pipe(Effect.catchTag("OnRampNotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: exhaustively paginate the on-ramp list,
      // then hydrate each id into the exact `read` Attributes shape via
      // `getOnRamp`. The list item omits some fields (`vpc`, `region`), so
      // a per-item get is required for a fully-faithful Attributes object.
      // Magic Cloud Networking is an entitlement-gated add-on; on accounts
      // without it every call fails with `FeatureNotEnabled` — treat that
      // as a non-listable account and return `[]`.
      const ids = yield* mcn.listOnRamps.items({ accountId }).pipe(
        Stream.map((onramp) => onramp.id),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("FeatureNotEnabled", () =>
          Effect.succeed([] as string[]),
        ),
      );
      const rows = yield* Effect.forEach(
        ids,
        (onRampId) =>
          getOnRamp(accountId, onRampId).pipe(
            Effect.map((observed) =>
              observed ? toAttributes(observed, accountId, false) : undefined,
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is OnRampAttributes => row !== undefined);
    }),
  });

type ObservedOnRamp = Pick<
  mcn.GetOnRampResponse,
  | "id"
  | "name"
  | "cloudType"
  | "type"
  | "dynamicRouting"
  | "installRoutesInCloud"
  | "installRoutesInMagicWan"
  | "vpc"
  | "cloudAsn"
  | "description"
  | "attachedHubs"
  | "attachedVpcs"
  | "manageHubToHubAttachments"
  | "manageVpcToHubAttachments"
  | "updatedAt"
  | "region"
>;

/**
 * Read an on-ramp by id, mapping "gone" (`OnRampNotFound`) to `undefined`.
 */
const getOnRamp = (accountId: string, onrampId: string) =>
  mcn.getOnRamp({ accountId, onrampId }).pipe(
    Effect.map((onramp): ObservedOnRamp | undefined => onramp),
    Effect.catchTag("OnRampNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find an on-ramp by exact name. Names are not unique on Cloudflare's side;
 * if several on-ramps carry the same name, pick the lexicographically-first
 * id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  mcn.listOnRamps.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((onramp) => onramp.name === name)
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
  );

const onRampName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const sameIds = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  onramp: ObservedOnRamp,
  accountId: string,
  destroyOnDelete: boolean,
): OnRampAttributes => ({
  onRampId: onramp.id,
  accountId,
  name: onramp.name,
  // Distilled widens generated string enums to open unions (`string & {}`).
  cloudType: onramp.cloudType as OnRampCloudType,
  type: onramp.type as OnRampType,
  dynamicRouting: onramp.dynamicRouting,
  installRoutesInCloud: onramp.installRoutesInCloud,
  installRoutesInMagicWan: onramp.installRoutesInMagicWan,
  vpc: onramp.vpc ?? undefined,
  cloudAsn: onramp.cloudAsn ?? undefined,
  description: onramp.description ?? undefined,
  attachedHubs: [...(onramp.attachedHubs ?? [])],
  attachedVpcs: [...(onramp.attachedVpcs ?? [])],
  manageHubToHubAttachments: onramp.manageHubToHubAttachments ?? undefined,
  manageVpcToHubAttachments: onramp.manageVpcToHubAttachments ?? undefined,
  updatedAt: onramp.updatedAt,
  destroyOnDelete,
});
