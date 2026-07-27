import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Addressing.ServiceBinding" as const;
type TypeId = typeof TypeId;

export interface ServiceBindingProps {
  /**
   * Identifier of the parent BYOIP prefix. Changing it forces a
   * replacement.
   */
  prefixId: string;
  /**
   * IP Prefix in Classless Inter-Domain Routing format to bind. Must be
   * contained in the parent prefix. Changing it forces a replacement.
   */
  cidr: string;
  /**
   * Identifier of the Cloudflare service (CDN, Spectrum, Magic Transit) to
   * bind the CIDR to. Service IDs are discoverable via the
   * `addressing.listServices` catalog. Changing it forces a replacement.
   */
  serviceId: string;
}

export interface ServiceBindingAttributes {
  /** Cloudflare-assigned identifier of the service binding. */
  bindingId: string;
  /** Identifier of the parent BYOIP prefix. */
  prefixId: string;
  /** The Cloudflare account the prefix belongs to. */
  accountId: string;
  /** Bound IP Prefix in CIDR format. */
  cidr: string;
  /** Identifier of the bound Cloudflare service. */
  serviceId: string;
  /** Name of the bound Cloudflare service. */
  serviceName: string | undefined;
  /**
   * Deployment status of the binding on the Cloudflare network.
   * Provisioning is asynchronous — `state` flips from `provisioning` to
   * `active` after a few minutes.
   */
  provisioning: { state: string | undefined };
}

export type ServiceBinding = Resource<
  TypeId,
  ServiceBindingProps,
  ServiceBindingAttributes,
  never,
  Providers
>;

/**
 * Binds part of a BYOIP prefix to a Cloudflare service (CDN, Spectrum, or
 * Magic Transit), routing traffic for the bound CIDR to that service.
 *
 * Bindings are create/delete only — every prop change forces a
 * replacement. Provisioning to the edge is asynchronous: the binding is
 * returned immediately with `provisioning.state: "provisioning"` and flips
 * to `"active"` on Cloudflare's side; the resource does not wait for it.
 * @resource
 * @product Addressing
 * @category Network
 * @section Binding a Prefix to a Service
 * @example Bind a /24 to the CDN
 * ```typescript
 * const binding = yield* Cloudflare.Addressing.ServiceBinding("cdn", {
 *   prefixId: prefix.prefixId,
 *   cidr: "192.0.2.0/24",
 *   serviceId: cdnServiceId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/byoip/concepts/service-bindings/
 */
export const ServiceBinding = Resource<ServiceBinding>(TypeId);

/**
 * Returns true if the given value is an ServiceBinding resource.
 */
export const isServiceBinding = (value: unknown): value is ServiceBinding =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ServiceBindingProvider = () =>
  Provider.succeed(ServiceBinding, {
    stables: ["bindingId", "prefixId", "accountId", "cidr", "serviceId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (olds === undefined) return undefined;
      if (!isResolved(news) || !isResolved(olds)) return undefined;
      // Create/delete only — any change forces a replacement.
      const oldPrefixId = output?.prefixId ?? olds.prefixId;
      if (
        typeof oldPrefixId === "string" &&
        typeof news.prefixId === "string" &&
        news.prefixId !== oldPrefixId
      ) {
        return { action: "replace" } as const;
      }
      if (news.cidr !== (output?.cidr ?? olds.cidr)) {
        return { action: "replace" } as const;
      }
      const oldServiceId = output?.serviceId ?? olds.serviceId;
      if (
        typeof oldServiceId === "string" &&
        typeof news.serviceId === "string" &&
        news.serviceId !== oldServiceId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const prefixId =
        output?.prefixId ??
        (typeof olds?.prefixId === "string" ? olds.prefixId : undefined);
      if (!prefixId) return undefined;

      if (output?.bindingId) {
        const observed = yield* getBinding(acct, prefixId, output.bindingId);
        return observed ? toAttributes(observed, prefixId, acct) : undefined;
      }
      // Cold read — (cidr, serviceId) identify a binding uniquely.
      const cidr = output?.cidr ?? olds?.cidr;
      if (typeof cidr !== "string") return undefined;
      const match = yield* findByCidr(acct, prefixId, cidr);
      return match ? toAttributes(match, prefixId, acct) : undefined;
    }),

    // Service bindings are children of a BYOIP prefix with no account-wide
    // enumeration API — fan out across every account prefix and list each
    // prefix's bindings, hydrating into the exact `read` shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const prefixIds = yield* addressing.listPrefixes
        .items({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .map((p) => p.id)
              .filter((id): id is string => typeof id === "string"),
          ),
        );
      const perPrefix = yield* Effect.forEach(
        prefixIds,
        (prefixId) =>
          addressing.listPrefixServiceBindings
            .items({ accountId, prefixId })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).map((b) =>
                  toAttributes(b, prefixId, accountId),
                ),
              ),
              // The parent prefix vanished between enumeration and listing.
              Effect.catchTag("PrefixNotFound", () =>
                Effect.succeed<ServiceBindingAttributes[]>([]),
              ),
            ),
        { concurrency: 10 },
      );
      return perPrefix.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const prefixId = news.prefixId as string;
      const serviceId = news.serviceId as string;

      // 1. Observe — by cached id, then by CIDR.
      let observed = output?.bindingId
        ? yield* getBinding(acct, prefixId, output.bindingId)
        : undefined;
      if (!observed) {
        observed = yield* findByCidr(acct, prefixId, news.cidr);
      }

      // 2. Ensure — nothing is mutable, so an observed binding is already
      //    converged (a serviceId mismatch is a replacement, handled by
      //    diff). Provisioning is async; return immediately.
      if (observed) {
        return toAttributes(observed, prefixId, acct);
      }
      const created = yield* addressing.createPrefixServiceBinding({
        accountId: acct,
        prefixId,
        cidr: news.cidr,
        serviceId,
      });
      return toAttributes(created, prefixId, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* addressing
        .deletePrefixServiceBinding({
          accountId: output.accountId,
          prefixId: output.prefixId,
          bindingId: output.bindingId,
        })
        .pipe(
          Effect.catchTag(
            ["BindingNotFound", "PrefixNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

type ObservedBinding = addressing.GetPrefixServiceBindingResponse;

/**
 * Read a service binding by id, mapping "gone" (`BindingNotFound` /
 * `PrefixNotFound`) to `undefined`.
 */
const getBinding = (accountId: string, prefixId: string, bindingId: string) =>
  addressing
    .getPrefixServiceBinding({ accountId, prefixId, bindingId })
    .pipe(
      Effect.catchTag(["BindingNotFound", "PrefixNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find a service binding by exact CIDR — unique within a parent prefix.
 * The parent prefix being gone reads as "no match".
 */
const findByCidr = (accountId: string, prefixId: string, cidr: string) =>
  addressing.listPrefixServiceBindings.items({ accountId, prefixId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((b) => b.cidr === cidr)),
    Effect.catchTag("PrefixNotFound", () => Effect.succeed(undefined)),
  );

const toAttributes = (
  binding: ObservedBinding,
  prefixId: string,
  accountId: string,
): ServiceBindingAttributes => ({
  bindingId: binding.id ?? "",
  prefixId,
  accountId,
  cidr: binding.cidr ?? "",
  serviceId: binding.serviceId ?? "",
  serviceName: binding.serviceName ?? undefined,
  provisioning: { state: binding.provisioning?.state ?? undefined },
});
