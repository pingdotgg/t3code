import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteApplePayDomain,
  GetApplePayDomains,
  GetApplePayDomain,
  CreateApplePayDomain,
  type ApplePayDomain as StripeApplePayDomain,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface ApplePayDomainProps {
  /**
   * Fully-qualified hostname to register with Apple Pay (e.g.
   * `"pay.example.com"`). Changing it replaces the domain. Stripe does
   * not support metadata on Apple Pay domains.
   */
  domainName: string;
}

export type ApplePayDomain = Resource<
  "Stripe.ApplePayDomain",
  ApplePayDomainProps,
  {
    /** Stripe Apple Pay domain id (`apwc_…`). */
    id: string;
    /** Fully-qualified hostname registered with Apple Pay. */
    domainName: string;
    /** Unix timestamp when the domain was registered. */
    created: number;
    /** Whether the domain exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Apple Pay Domain — a hostname registered so Apple Pay can be
 * offered on that origin. Existence-only: there is nothing to update in
 * place; changing `domainName` replaces the registration. Destroy deletes
 * it.
 *
 * Apple Pay domains have no metadata. Account-wide `list()` (nuke)
 * enumerates every domain on the account.
 *
 * In test mode, Stripe does not require the Apple domain-association
 * file. Live mode requires
 * `/.well-known/apple-developer-merchantid-domain-association` on the
 * hostname before registration succeeds.
 *
 * @see https://docs.stripe.com/apple-pay
 *
 * ### Registering a Domain
 * **Example:** Basic domain
 * ```typescript
 * const pay = yield* Stripe.ApplePayDomain("checkout", {
 *   domainName: "pay.example.com",
 * });
 * ```
 *
 * ### Replacing a Domain
 * **Example:** Point at a different hostname
 * ```typescript
 * const pay = yield* Stripe.ApplePayDomain("checkout", {
 *   domainName: "checkout.example.com",
 * });
 * ```
 *
 * ### Deleting a Domain
 * **Example:** Destroy deletes the registration
 * ```typescript
 * // stack.destroy() / resource removal deletes the Apple Pay domain
 * const pay = yield* Stripe.ApplePayDomain("checkout", {
 *   domainName: "pay.example.com",
 * });
 * ```
 *
 * @resource
 */
export const ApplePayDomain = Resource<ApplePayDomain>("Stripe.ApplePayDomain");

export class ApplePayDomainNotResolved extends Data.TaggedError(
  "Stripe.ApplePayDomainNotResolved",
)<{
  domainName: string;
}> {}

type ApplePayDomainAttributes = ApplePayDomain["Attributes"];

const toAttrs = (domain: StripeApplePayDomain): ApplePayDomainAttributes => ({
  id: domain.id,
  domainName: domain.domain_name,
  created: domain.created,
  livemode: domain.livemode,
});

const isMissing = isMissingStripeResource;

const getById = (domain: string) =>
  GetApplePayDomain({ domain }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );

const listAllApplePayDomains = Effect.fn(function* () {
  const domains: StripeApplePayDomain[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetApplePayDomains({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    domains.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return domains;
});

const findByDomainName = Effect.fn(function* (domainName: string) {
  const matches: StripeApplePayDomain[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetApplePayDomains({
      domain_name: domainName,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    for (const domain of response.data) {
      if (domain.domain_name === domainName) {
        matches.push(domain);
      }
    }
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  domainName?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.domainName !== undefined) {
    return yield* findByDomainName(input.domainName);
  }
  return undefined;
});

const shouldReplace = (
  news: ApplePayDomainProps,
  output: ApplePayDomainAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  return news.domainName !== output.domainName;
};

export const ApplePayDomainProvider = () =>
  Provider.succeed(ApplePayDomain, {
    stables: ["id", "domainName", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const domainName =
        output?.domainName ??
        (typeof olds?.domainName === "string" ? olds.domainName : undefined);
      const existing = yield* observe({
        id: output?.id,
        domainName,
      });
      if (existing === undefined) return undefined;
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // Apple Pay domains have no metadata. Account-wide list so nuke can
      // tear down leaked registrations.
      const domains = yield* listAllApplePayDomains();
      return domains.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      let current = yield* observe({
        id: output?.id,
        domainName: news.domainName,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateApplePayDomain({
          domain_name: news.domainName,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-apple-pay-domain-${instanceId}`,
          }),
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({ domainName: news.domainName }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      if (current === undefined) {
        return yield* new ApplePayDomainNotResolved({
          domainName: news.domainName,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteApplePayDomain({ domain: output.id }).pipe(
        Effect.catchIf(isMissing, () => Effect.void),
      );
    }),
  });
