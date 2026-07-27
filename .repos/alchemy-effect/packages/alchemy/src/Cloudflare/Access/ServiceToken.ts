import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type ServiceTokenProps = {
  /**
   * Display name for the service token. Used as a stable identifier so the
   * provider can locate the token by name during adoption / state recovery.
   * If omitted, a unique name is generated from the stack/stage/logical id.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * How long the service token is valid. Must be in the format `300ms` or
   * `2h45m`. Valid time units are: ns, us (or µs), ms, s, m, h.
   *
   * @default "8760h" (1 year)
   */
  duration?: string;
  /**
   * A version number identifying the current client secret. Incrementing it
   * triggers a rotation — a new client secret is generated and the previous
   * secret remains valid until `previousClientSecretExpiresAt`.
   *
   * @default 1
   */
  clientSecretVersion?: number;
  /**
   * The expiration of the previous client secret (RFC3339 timestamp). Only
   * meaningful after a rotation; may be extended to give consumers more
   * time to roll over to the new secret.
   */
  previousClientSecretExpiresAt?: string;
};

export type ServiceToken = Resource<
  "Cloudflare.Access.ServiceToken",
  ServiceTokenProps,
  {
    /** UUID of the service token assigned by Cloudflare. */
    serviceTokenId: string;
    /** Cloudflare account that owns the service token. */
    accountId: string;
    /** Client ID sent in the `CF-Access-Client-ID` request header. */
    clientId: string;
    /**
     * Client secret sent in the `CF-Access-Client-Secret` request header.
     * Cloudflare only returns it on create and rotate, so the provider
     * persists it (redacted) and carries it forward on read.
     */
    clientSecret: Redacted.Redacted<string> | undefined;
    /** Display name reported by Cloudflare. */
    name: string;
    /** Validity duration reported by Cloudflare, e.g. `8760h`. */
    duration: string | undefined;
    /** Expiration timestamp of the current client secret. */
    expiresAt: string | undefined;
    /** The client secret version this token was last reconciled to. */
    clientSecretVersion: number;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Access service token. Service tokens let
 * machine-to-machine clients authenticate to Access-protected applications
 * by sending the `CF-Access-Client-ID` / `CF-Access-Client-Secret` headers.
 *
 * The client secret is only revealed by Cloudflare on create and rotate; the
 * provider stores it redacted in state and carries it forward across reads.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Service Token
 * @example Basic token with a generated name
 * ```typescript
 * const token = yield* Cloudflare.Access.ServiceToken("Ci", {});
 * // token.clientId / token.clientSecret authenticate requests
 * ```
 *
 * @example Token with an explicit name and validity
 * ```typescript
 * const token = yield* Cloudflare.Access.ServiceToken("Deploys", {
 *   name: "deploy-bot",
 *   duration: "17520h", // 2 years
 * });
 * ```
 *
 * @section Rotating the Secret
 * @example Increment clientSecretVersion to rotate
 * ```typescript
 * const token = yield* Cloudflare.Access.ServiceToken("Ci", {
 *   clientSecretVersion: 2, // was 1 — bumping rotates the secret
 * });
 * ```
 *
 * @section Authorizing a Token
 * @example Reference from an Access policy
 * ```typescript
 * const token = yield* Cloudflare.Access.ServiceToken("Ci", {});
 *
 * const policy = yield* Cloudflare.Access.Policy("AllowCi", {
 *   decision: "non_identity",
 *   include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
 * });
 * ```
 */
export const ServiceToken = Resource<ServiceToken>(
  "Cloudflare.Access.ServiceToken",
);

export const isServiceToken = (value: unknown): value is ServiceToken =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Access.ServiceToken";

export const ServiceTokenProvider = () =>
  Provider.succeed(ServiceToken, {
    stables: ["serviceTokenId", "accountId", "clientId"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessServiceTokensForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter(
                  (
                    t,
                  ): t is (typeof page.result)[number] & {
                    id: string;
                    clientId: string;
                  } => t.id != null && t.clientId != null,
                )
                .map((t) => ({
                  serviceTokenId: t.id,
                  accountId,
                  clientId: t.clientId,
                  // The secret is only revealed on create/rotate, never on
                  // enumeration — match read and leave it undefined.
                  clientSecret: undefined,
                  name: t.name ?? "",
                  duration: t.duration ?? undefined,
                  expiresAt: t.expiresAt ?? undefined,
                  clientSecretVersion: 1,
                })),
            ),
          ),
        );
    }),
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // name/duration converge via PUT; clientSecretVersion bumps rotate.
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.serviceTokenId) {
        const direct = yield* zeroTrust
          .getAccessServiceTokenForAccount({
            accountId: acct,
            serviceTokenId: output.serviceTokenId,
          })
          .pipe(
            Effect.catchTag("AccessServiceTokenNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (direct && direct.id) {
          return {
            serviceTokenId: direct.id,
            accountId: acct,
            clientId: direct.clientId ?? output.clientId,
            // The API never returns the secret on GET — carry it forward.
            clientSecret: output.clientSecret,
            name: direct.name ?? output.name,
            duration: direct.duration ?? output.duration,
            expiresAt: direct.expiresAt ?? output.expiresAt,
            clientSecretVersion: output.clientSecretVersion,
          };
        }
      }
      const name = yield* createTokenName(id, olds?.name ?? output?.name);
      const existing = yield* findTokenByName(acct, name);
      if (!existing || !existing.id || !existing.clientId) return undefined;
      return {
        serviceTokenId: existing.id,
        accountId: acct,
        clientId: existing.clientId,
        clientSecret: output?.clientSecret,
        name: existing.name ?? name,
        duration: existing.duration ?? undefined,
        expiresAt: existing.expiresAt ?? undefined,
        clientSecretVersion: output?.clientSecretVersion ?? 1,
      };
    }),
    reconcile: Effect.fn(function* ({
      id,
      news = {} as ServiceTokenProps,
      olds,
      output,
    }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createTokenName(id, news.name);
      const acct = output?.accountId ?? accountId;
      const desiredVersion = news.clientSecretVersion ?? 1;

      // Observe — prefer the cached id, fall back to a name lookup so we
      // recover from out-of-band deletes and partial state-persistence
      // failures.
      let observed: ObservedToken | undefined;
      if (output?.serviceTokenId) {
        observed = yield* zeroTrust
          .getAccessServiceTokenForAccount({
            accountId: acct,
            serviceTokenId: output.serviceTokenId,
          })
          .pipe(
            Effect.catchTag("AccessServiceTokenNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (!observed || !observed.id) {
        observed = yield* findTokenByName(acct, name);
      }

      // Ensure — create the token when missing, capturing the one-time
      // client secret. Tolerate a same-named create race by re-observing.
      if (!observed || !observed.id) {
        const created = yield* zeroTrust
          .createAccessServiceTokenForAccount({
            accountId: acct,
            name,
            duration: news.duration,
            clientSecretVersion: news.clientSecretVersion,
            previousClientSecretExpiresAt: news.previousClientSecretExpiresAt,
          })
          .pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                const existing = yield* findTokenByName(acct, name);
                if (existing && existing.id) return existing;
                return yield* Effect.fail(err);
              }),
            ),
          );
        if (!created.id || !created.clientId) {
          return yield* Effect.fail(
            new Error("ServiceToken: created token missing id"),
          );
        }
        const fresh = yield* zeroTrust.getAccessServiceTokenForAccount({
          accountId: acct,
          serviceTokenId: created.id,
        });
        return {
          serviceTokenId: created.id,
          accountId: acct,
          clientId: created.clientId,
          clientSecret:
            "clientSecret" in created &&
            typeof created.clientSecret === "string"
              ? Redacted.make(created.clientSecret)
              : output?.clientSecret,
          name: created.name ?? name,
          duration: created.duration ?? news.duration,
          expiresAt: fresh.expiresAt ?? undefined,
          clientSecretVersion: desiredVersion,
        };
      }

      // Sync — converge name/duration via PUT only when the observed state
      // differs from the desired state. The PUT deliberately omits
      // clientSecretVersion: rotation must go through the explicit rotate
      // endpoint, which is the only call that returns the new secret.
      let synced = observed;
      if (observed.name !== name || differs(news.duration, observed.duration)) {
        const updated = yield* zeroTrust.updateAccessServiceTokenForAccount({
          accountId: acct,
          serviceTokenId: observed.id,
          name,
          duration: news.duration,
          previousClientSecretExpiresAt: news.previousClientSecretExpiresAt,
        });
        synced = {
          id: updated.id ?? observed.id,
          clientId: updated.clientId ?? observed.clientId,
          name: updated.name ?? observed.name,
          duration: updated.duration ?? observed.duration,
          expiresAt: updated.expiresAt ?? observed.expiresAt,
        };
      }

      // Rotate — when the declared secret version moved past the version we
      // last reconciled, mint a new secret. The previous secret stays valid
      // until previousClientSecretExpiresAt.
      const priorVersion =
        output?.clientSecretVersion ?? olds?.clientSecretVersion ?? 1;
      let clientSecret = output?.clientSecret;
      if (desiredVersion > priorVersion) {
        const rotated = yield* zeroTrust.rotateAccessServiceToken({
          accountId: acct,
          serviceTokenId: synced.id!,
          previousClientSecretExpiresAt: news.previousClientSecretExpiresAt,
        });
        if (typeof rotated.clientSecret === "string") {
          clientSecret = Redacted.make(rotated.clientSecret);
        }
        synced = {
          ...synced,
          clientId: rotated.clientId ?? synced.clientId,
          name: rotated.name ?? synced.name,
          duration: rotated.duration ?? synced.duration,
        };
      }

      if (!synced.id || !synced.clientId) {
        return yield* Effect.fail(
          new Error("ServiceToken: ensured token missing id"),
        );
      }
      return {
        serviceTokenId: synced.id,
        accountId: acct,
        clientId: synced.clientId,
        clientSecret,
        name: synced.name ?? name,
        duration: synced.duration ?? news.duration,
        expiresAt: synced.expiresAt ?? undefined,
        clientSecretVersion: Math.max(desiredVersion, priorVersion),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessServiceTokenForAccount({
          accountId: output.accountId,
          serviceTokenId: output.serviceTokenId,
        })
        .pipe(Effect.catchTag("AccessServiceTokenNotFound", () => Effect.void));
    }),
  });

const createTokenName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const findTokenByName = (acct: string, name: string) =>
  zeroTrust.listAccessServiceTokensForAccount.items({ accountId: acct }).pipe(
    Stream.filter((t): t is ObservedToken => t.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );

// Skip no-op PUTs while treating an unset prop as "keep whatever Cloudflare
// has" rather than a difference.
const differs = (
  desired: string | undefined,
  observed: string | null | undefined,
) => desired !== undefined && desired !== (observed ?? undefined);

type ObservedToken = {
  id?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  name?: string | null;
  duration?: string | null;
  expiresAt?: string | null;
};
