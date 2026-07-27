import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Stream.SigningKey" as const;
type TypeId = typeof TypeId;

export type SigningKeyProps = {};

export type SigningKeyAttributes = {
  /**
   * The unique identifier of the signing key.
   */
  keyId: string;
  /**
   * The Cloudflare account the signing key belongs to.
   */
  accountId: string;
  /**
   * The date and time the signing key was created.
   */
  created: string | undefined;
  /**
   * The signing key in PEM format. Only returned by Cloudflare at
   * creation time — preserved in state thereafter.
   */
  pem: Redacted.Redacted<string>;
  /**
   * The signing key in JWK format. Only returned by Cloudflare at
   * creation time — preserved in state thereafter.
   */
  jwk: Redacted.Redacted<string>;
};

export type SigningKey = Resource<
  TypeId,
  SigningKeyProps,
  SigningKeyAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Stream signing key — an RSA key pair used to sign viewer
 * playback tokens for videos that require signed URLs.
 *
 * The key material (`pem`/`jwk`) is returned by Cloudflare **only at
 * creation time**; it is persisted as redacted attributes in state and
 * can never be re-read from the API. If the key is deleted out-of-band,
 * reconcile creates a brand-new key with new material — anything derived
 * from the old key (signed tokens) must be re-derived from the new
 * attributes.
 *
 * Requires the Stream subscription to be enabled on the account.
 * @resource
 * @product Stream
 * @category Media
 * @section Creating a signing key
 * @example Signing key for signed playback URLs
 * ```typescript
 * const key = yield* Cloudflare.Stream.SigningKey("PlaybackKey", {});
 *
 * // key.pem / key.jwk are Redacted<string> — use them server-side to
 * // sign playback tokens for videos with requireSignedURLs enabled.
 * const pem = key.pem;
 * ```
 *
 * @see https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
 */
export const SigningKey = Resource<SigningKey>(TypeId);

/**
 * Returns true if the given value is a SigningKey resource.
 */
export const isSigningKey = (value: unknown): value is SigningKey =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SigningKeyProvider = () =>
  Provider.succeed(SigningKey, {
    stables: ["keyId", "accountId", "created", "pem", "jwk"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: the keys list endpoint only returns
      // `id` + `created`. The key material (pem/jwk) is create-only and
      // can never be re-read, so — matching `read` for a key with no
      // cached state — we surface it as empty redacted values.
      return yield* stream.getKey.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (key): key is { id: string; created?: string | null } =>
                  typeof key.id === "string",
              )
              .map(
                (key) =>
                  ({
                    keyId: key.id,
                    accountId,
                    created: key.created ?? undefined,
                    pem: Redacted.make(""),
                    jwk: Redacted.make(""),
                  }) satisfies SigningKeyAttributes,
              ),
          ),
        ),
        // Accounts without the Stream subscription are forbidden from the
        // keys endpoint — treat as an empty collection.
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // No mutable props.
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // The list endpoint only returns `id` + `created` — the key
      // material is create-only, so without cached state there is
      // nothing to recover.
      if (output?.keyId === undefined) return undefined;
      const found = yield* findKey(output.accountId, output.keyId);
      // Preserve the stored pem/jwk; the API can never return them again.
      return found ? output : undefined;
    }),

    reconcile: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Observe — existence-only resource: check the key is still listed.
      const exists = output?.keyId
        ? yield* findKey(output.accountId ?? accountId, output.keyId)
        : false;

      if (exists && output !== undefined) {
        // Nothing mutable to sync — keep the cached attributes (they
        // carry the create-only key material).
        return output;
      }

      // Ensure — create a new key (`createKey` takes an empty body).
      const created = yield* stream.createKey({ accountId, body: {} });
      return {
        keyId: created.id ?? "",
        accountId,
        created: created.created ?? undefined,
        pem: Redacted.make(created.pem ?? ""),
        jwk: Redacted.make(created.jwk ?? ""),
      } satisfies SigningKeyAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — a key already deleted out-of-band surfaces as
      // `SigningKeyNotFound` (Cloudflare error code 10003).
      yield* stream
        .deleteKey({ accountId: output.accountId, identifier: output.keyId })
        .pipe(Effect.catchTag("SigningKeyNotFound", () => Effect.void));
    }),
  });

/**
 * True when the signing key with the given id is present in the
 * account's key list. Cloudflare returns `result: null` (not `[]`) when
 * the account has no keys.
 */
const findKey = (accountId: string, keyId: string) =>
  stream
    .getKey({ accountId })
    .pipe(
      Effect.map((response) =>
        (response.result ?? []).some((key) => key.id === keyId),
      ),
    );
