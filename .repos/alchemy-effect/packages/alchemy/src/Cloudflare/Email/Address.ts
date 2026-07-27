import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type AddressProps = {
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

export type Address = Resource<
  "Cloudflare.Email.Address",
  AddressProps,
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
 * as forwarding targets in `Rule` actions and can also serve as the
 * `destinationAddress` on a `send_email` Worker binding.
 * @resource
 * @product Email
 * @category Email
 * @section Registering an Address
 * @example Register a destination address
 * ```typescript
 * const ops = yield* Cloudflare.Email.Address("Ops", {
 *   email: "ops@example.com",
 * });
 * ```
 *
 * Cloudflare sends a verification email when the address is first created.
 * The address must be verified before it can receive routed mail.
 */
export const Address = Resource<Address>("Cloudflare.Email.Address", {
  aliases: ["Cloudflare.EmailAddress"],
});

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

// Authoritative account-wide lookup of a destination address by email. The
// per-address `getAddress` identifier is the opaque address id (not the email),
// so the only reliable way to find an address by its email is to enumerate the
// account collection (the same call `list()` exhausts).
const findByEmail = (accountId: string, email: string) =>
  emailRouting.listAddresses.pages({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .flatMap((page) => page.result ?? [])
        .map((addr) => toAttrs(accountId, addr))
        .find((a) => a.email === email),
    ),
  );

export const AddressProvider = () =>
  Provider.succeed(Address, {
    stables: ["addressId", "accountId", "email"],
    // Account collection: destination addresses are enumerable account-wide.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* emailRouting.listAddresses.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((addr) => toAttrs(accountId, addr)),
          ),
        ),
      );
    }),
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
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
      const { accountId } = yield* yield* CloudflareEnvironment;
      const identifier =
        output?.addressId ??
        (olds?.email ? encodeURIComponent(olds.email) : undefined);
      if (!identifier) return undefined;
      const acct = output?.accountId ?? accountId;
      return yield* emailRouting
        .getAddress({
          accountId: acct,
          destinationAddressIdentifier: identifier,
        })
        .pipe(
          Effect.map((r) => toAttrs(acct, r)),
          Effect.catch(() => Effect.succeed(undefined)),
        );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const email = news.email;

      // Observe — by addressId if known, else by email lookup.
      let observed: ReturnType<typeof toAttrs> | undefined = output?.addressId
        ? yield* emailRouting
            .getAddress({
              accountId: acct,
              destinationAddressIdentifier: output.addressId,
            })
            .pipe(
              Effect.map((r) => toAttrs(acct, r)),
              Effect.catch(() => Effect.succeed(undefined)),
            )
        : undefined;

      if (!observed) {
        observed = yield* emailRouting
          .getAddress({
            accountId: acct,
            destinationAddressIdentifier: encodeURIComponent(email),
          })
          .pipe(
            Effect.map((r) => toAttrs(acct, r)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
      }

      // Ensure — register the address if it doesn't already exist.
      if (!observed) {
        observed = yield* emailRouting
          .createAddress({ accountId: acct, email })
          .pipe(
            Effect.map((created) => toAttrs(acct, created)),
            // Cloudflare rate-limits verification emails per destination
            // address ("Verification email has been sent too recently"). When
            // the same address was (re)created recently the address record
            // already exists account-wide, so adopt it instead of failing.
            // Re-raise if the address genuinely isn't present.
            Effect.catchTag("TooManyRequests", (error) =>
              findByEmail(acct, email).pipe(
                Effect.flatMap((found) =>
                  found ? Effect.succeed(found) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      return observed;
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!output?.addressId) return;
      yield* emailRouting
        .deleteAddress({
          accountId: output.accountId,
          destinationAddressIdentifier: output.addressId,
        })
        .pipe(Effect.catch(() => Effect.void));
    }),
  });
