import * as cni from "@distilled.cloud/cloudflare/network-interconnects";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.NetworkInterconnects.Settings" as const;
type TypeId = typeof TypeId;

export interface NetworkInterconnectSettingsProps {
  /**
   * The default ASN (Autonomous System Number) used for new CNI BGP
   * sessions on this account when a CNI does not specify its own
   * `customerAsn`.
   *
   * Mutable — updated in place via `PUT /accounts/{account_id}/cni/settings`.
   */
  defaultAsn: number;
}

export interface NetworkInterconnectSettingsAttributes {
  /** Account the CNI settings belong to. */
  accountId: string;
  /** The currently configured default ASN. */
  defaultAsn: number;
  /**
   * The default ASN observed before Alchemy first managed this
   * singleton. Restored on destroy, so deleting the resource puts the
   * account back the way it was found.
   */
  initialDefaultAsn: number;
}

export type NetworkInterconnectSettings = Resource<
  TypeId,
  NetworkInterconnectSettingsProps,
  NetworkInterconnectSettingsAttributes,
  never,
  Providers
>;

/**
 * Account-level settings for Cloudflare Network Interconnect (CNI v2) —
 * currently the default ASN applied to new CNI BGP configurations
 * (`/accounts/{account_id}/cni/settings`).
 *
 * The settings object is an **account singleton** — it always exists and
 * can never be created or deleted. Reconcile PUTs the desired value when
 * the observed value differs; destroy restores the value the setting had
 * before Alchemy first managed it (captured as `initialDefaultAsn`).
 *
 * CNI is an enterprise feature — on accounts without the Network
 * Interconnect entitlement the endpoint fails with the typed `Forbidden`
 * error.
 * @resource
 * @product Network Interconnects
 * @category Network
 * @section Managing the default ASN
 * @example Pin the account's default ASN
 * ```typescript
 * yield* Cloudflare.NetworkInterconnects.NetworkInterconnectSettings("CniSettings", {
 *   defaultAsn: 65000,
 * });
 * ```
 *
 * @example Use a private 32-bit ASN
 * ```typescript
 * yield* Cloudflare.NetworkInterconnects.NetworkInterconnectSettings("CniSettings", {
 *   defaultAsn: 4200000001,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/network-interconnect/
 */
export const NetworkInterconnectSettings =
  Resource<NetworkInterconnectSettings>(TypeId);

/**
 * Returns true if the given value is a NetworkInterconnectSettings resource.
 */
export const isNetworkInterconnectSettings = (
  value: unknown,
): value is NetworkInterconnectSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const NetworkInterconnectSettingsProvider = () =>
  Provider.succeed(NetworkInterconnectSettings, {
    nuke: { singleton: true },
    stables: ["accountId", "initialDefaultAsn"],

    // Account singleton — there is no enumeration API, just the single
    // `/accounts/{account_id}/cni/settings` object. Read it and return a
    // one-element array (mirroring `read` with no prior output, so
    // `initialDefaultAsn` is the observed value). CNI is an enterprise
    // feature: accounts without the entitlement reject the route with the
    // typed `Forbidden` error — treat that as "unset" and return `[]`.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* cni
        .getSetting({ accountId })
        .pipe(Effect.catchTag("Forbidden", () => Effect.succeed(undefined)));
      if (observed === undefined) return [];
      return [
        {
          accountId,
          defaultAsn: observed.defaultAsn,
          initialDefaultAsn: observed.defaultAsn,
        },
      ];
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The settings singleton always exists with a Cloudflare default —
      // there is nothing to "own", so a cold read adopts freely (never
      // `Unowned`). The observed value at adoption time becomes the
      // `initialDefaultAsn` restored on destroy.
      const observed = yield* cni.getSetting({ accountId });
      const initialDefaultAsn =
        output !== undefined ? output.initialDefaultAsn : observed.defaultAsn;
      return {
        accountId,
        defaultAsn: observed.defaultAsn,
        initialDefaultAsn,
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the singleton always exists; read its live value.
      const observed = yield* cni.getSetting({ accountId });

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the account's original.
      const initialDefaultAsn =
        output !== undefined ? output.initialDefaultAsn : observed.defaultAsn;

      // 3. Sync — PUT only when the observed value differs.
      if (observed.defaultAsn === news.defaultAsn) {
        return {
          accountId,
          defaultAsn: observed.defaultAsn,
          initialDefaultAsn,
        };
      }
      const updated = yield* cni.putSetting({
        accountId,
        defaultAsn: news.defaultAsn,
      });
      return {
        accountId,
        defaultAsn: updated.defaultAsn,
        initialDefaultAsn,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, initialDefaultAsn } = output;
      // Observe — restore the pre-management value; skip the call when
      // it already matches (idempotent re-delete after a crashed run).
      const observed = yield* cni.getSetting({ accountId });
      if (observed.defaultAsn === initialDefaultAsn) return;
      yield* cni.putSetting({ accountId, defaultAsn: initialDefaultAsn });
    }),
  });
