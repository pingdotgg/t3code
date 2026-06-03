import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type EmailAddressProps = {
  /**
   * The email address to register as a verified destination on the
   * account. Cloudflare sends a verification email to this address; the
   * recipient must click the link before the address can receive routed
   * mail or be used as a verified sender.
   *
   * Changing this property triggers a replacement.
   */
  email: string;
};

export type EmailAddress = Resource<
  "Cloudflare.EmailAddress",
  EmailAddressProps,
  {
    addressId: string;
    email: string;
    accountId: string;
    verified: boolean;
    verifiedAt: string | undefined;
    created: string | undefined;
    modified: string | undefined;
  },
  never,
  Providers
>;

/**
 * A verified destination email address on the account.
 *
 * Destination addresses are account-scoped (not zone-scoped). They are used
 * as forwarding targets in `EmailRule` actions and can also serve as the
 * `destinationAddress` on a `send_email` Worker binding.
 *
 * @section Registering an Address
 * @example Register a destination address
 * ```typescript
 * const ops = yield* Cloudflare.EmailAddress("Ops", {
 *   email: "ops@example.com",
 * });
 * ```
 *
 * Cloudflare sends a verification email when the address is first created.
 * The address must be verified before it can receive routed mail.
 */
export const EmailAddress = Resource<EmailAddress>("Cloudflare.EmailAddress");

const toAttrs = (
  accountId: string,
  result: {
    id?: string | null;
    email?: string | null;
    verified?: string | null;
    created?: string | null;
    modified?: string | null;
  },
) => ({
  addressId: result.id ?? "",
  email: result.email ?? "",
  accountId,
  verified: Boolean(result.verified),
  verifiedAt: result.verified ?? undefined,
  created: result.created ?? undefined,
  modified: result.modified ?? undefined,
});

export const EmailAddressProvider = () =>
  Provider.effect(
    EmailAddress,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const create = yield* emailRouting.createAddress;
      const get = yield* emailRouting.getAddress;
      const del = yield* emailRouting.deleteAddress;

      return {
        stables: ["addressId", "accountId", "email"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!output) return undefined;
          if (output.accountId !== accountId) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news)) return undefined;
          if (news.email !== output.email) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const identifier =
            output?.addressId ??
            (olds?.email ? encodeURIComponent(olds.email) : undefined);
          if (!identifier) return undefined;
          const acct = output?.accountId ?? accountId;
          return yield* get({
            accountId: acct,
            destinationAddressIdentifier: identifier,
          }).pipe(
            Effect.map((r) => toAttrs(acct, r)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const acct = output?.accountId ?? accountId;
          const email = news.email;

          // Observe — by addressId if known, else by email lookup.
          let observed: ReturnType<typeof toAttrs> | undefined =
            output?.addressId
              ? yield* get({
                  accountId: acct,
                  destinationAddressIdentifier: output.addressId,
                }).pipe(
                  Effect.map((r) => toAttrs(acct, r)),
                  Effect.catch(() => Effect.succeed(undefined)),
                )
              : undefined;

          if (!observed) {
            observed = yield* get({
              accountId: acct,
              destinationAddressIdentifier: encodeURIComponent(email),
            }).pipe(
              Effect.map((r) => toAttrs(acct, r)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }

          // Ensure — register the address if it doesn't already exist.
          if (!observed) {
            const created = yield* create({ accountId: acct, email });
            observed = toAttrs(acct, created);
          }

          return observed;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output?.addressId) return;
          yield* del({
            accountId: output.accountId,
            destinationAddressIdentifier: output.addressId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
