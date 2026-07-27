import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DNS.ZoneTransferTsig" as const;
type TypeId = typeof TypeId;

export interface ZoneTransferTsigProps {
  /**
   * TSIG key name. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
   *
   * Mutable — updated in place (PUT).
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * TSIG algorithm (e.g. `hmac-sha512.`).
   *
   * Mutable — updated in place (PUT).
   */
  algo: string;
  /**
   * TSIG secret (base64-encoded key material). Kept redacted — it is
   * never stored in the resource's attributes.
   *
   * Mutable — updated in place (PUT).
   */
  secret: Redacted.Redacted<string>;
}

export interface ZoneTransferTsigAttributes {
  /** Identifier of the TSIG. */
  tsigId: string;
  /** The Cloudflare account the TSIG belongs to. */
  accountId: string;
  /** TSIG key name. */
  name: string;
  /** TSIG algorithm. */
  algo: string;
}

export type ZoneTransferTsig = Resource<
  TypeId,
  ZoneTransferTsigProps,
  ZoneTransferTsigAttributes,
  never,
  Providers
>;

/**
 * A Secondary DNS TSIG key
 * (`/accounts/{account_id}/secondary_dns/tsigs`) — shared-secret
 * authentication for zone transfers between Cloudflare and external
 * nameservers. Reference it from a {@link ZoneTransferPeer} via
 * `tsigId`.
 *
 * Requires the Secondary DNS (zone transfer) entitlement on the
 * account. All fields are mutable in place; the secret is redacted and
 * never persisted in attributes.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Creating a TSIG
 * @example HMAC-SHA512 key
 * ```typescript
 * const tsig = yield* Cloudflare.DNS.ZoneTransferTsig("TransferKey", {
 *   algo: "hmac-sha512.",
 *   secret: Redacted.make(process.env.TSIG_SECRET!),
 * });
 * ```
 *
 * @section Using with a Peer
 * @example Authenticate transfers from a primary nameserver
 * ```typescript
 * const peer = yield* Cloudflare.DNS.ZoneTransferPeer("Primary", {
 *   ip: "192.0.2.53",
 *   port: 53,
 *   tsigId: tsig.tsigId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/zone-setups/zone-transfers/
 */
export const ZoneTransferTsig = Resource<ZoneTransferTsig>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneTransferTsig"],
});

/**
 * Returns true if the given value is a ZoneTransferTsig resource.
 */
export const isZoneTransferTsig = (value: unknown): value is ZoneTransferTsig =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneTransferTsigProvider = () =>
  Provider.succeed(ZoneTransferTsig, {
    stables: ["tsigId", "accountId"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.tsigId) {
        const observed = yield* getTsig(acct, output.tsigId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the
      // deterministic physical name. TSIGs carry no ownership markers,
      // so gate takeover behind adoption.
      const name = yield* createTsigName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? Unowned(toAttributes(match, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createTsigName(id, news.name);
      const secret = Redacted.value(news.secret);

      // Observe — the id cached on `output` is a hint, not a guarantee.
      const observed = output?.tsigId
        ? yield* getTsig(output.accountId ?? accountId, output.tsigId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). Names are not
        // unique, so there is no AlreadyExists race to tolerate.
        const created = yield* dns.createZoneTransferTsig({
          accountId,
          name,
          algo: news.algo,
          secret,
        });
        return toAttributes(created, accountId);
      }

      // Sync — PUT with the full body; skip the call on no delta. The
      // observed secret comes back from the GET, so the comparison is
      // exact (not a guess from `olds`).
      if (
        observed.name === name &&
        observed.algo === news.algo &&
        observed.secret === secret
      ) {
        return toAttributes(observed, output?.accountId ?? accountId);
      }
      const updated = yield* dns.updateZoneTransferTsig({
        accountId: output?.accountId ?? accountId,
        tsigId: observed.id,
        name,
        algo: news.algo,
        secret,
      });
      return toAttributes(updated, output?.accountId ?? accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteZoneTransferTsig({
          accountId: output.accountId,
          tsigId: output.tsigId,
        })
        .pipe(Effect.catchTag("TsigNotFound", () => Effect.void));
    }),

    // Account collection — enumerate every TSIG in the account via the
    // account-scoped list API, paginate exhaustively, and hydrate each into
    // the same Attributes shape `read` returns (the secret is write-only and
    // never persisted).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* dns.listZoneTransferTsigs.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((tsig) => toAttributes(tsig, accountId)),
          ),
        ),
      );
    }),
  });

type ObservedTsig =
  | dns.GetZoneTransferTsigResponse
  | dns.CreateZoneTransferTsigResponse
  | dns.UpdateZoneTransferTsigResponse;

/** Read a TSIG by id, mapping "gone" (404) to `undefined`. */
const getTsig = (accountId: string, tsigId: string) =>
  dns
    .getZoneTransferTsig({ accountId, tsigId })
    .pipe(Effect.catchTag("TsigNotFound", () => Effect.succeed(undefined)));

/**
 * Find a TSIG by exact name. Names are not unique on Cloudflare's side;
 * pick the lexicographically-first id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  dns.listZoneTransferTsigs.items({ accountId }).pipe(
    Stream.filter((t) => t.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
  );

const createTsigName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  tsig: Pick<ObservedTsig, "id" | "name" | "algo">,
  accountId: string,
): ZoneTransferTsigAttributes => ({
  tsigId: tsig.id,
  accountId,
  name: tsig.name,
  algo: tsig.algo,
});
