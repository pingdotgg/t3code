import * as images from "@distilled.cloud/cloudflare/images";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Images.SigningKey" as const;
type TypeId = typeof TypeId;

export interface SigningKeyProps {
  /**
   * Account the signing key is created in. Defaults to the ambient
   * Cloudflare account. Changing it triggers a replacement.
   */
  accountId?: string;
  /**
   * Name of the signing key — the PUT path identifier. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing the
   * name triggers a replacement.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
}

export interface SigningKeyAttributes {
  /** The signing key's name (its API path identifier). */
  keyName: string;
  /** Account the key belongs to. */
  accountId: string;
  /** The HMAC key material used to sign image delivery URLs. */
  value: Redacted.Redacted<string>;
}

export type SigningKey = Resource<
  TypeId,
  SigningKeyProps,
  SigningKeyAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Images signing key — an HMAC key used to generate signed
 * image delivery URLs (`?sig=` tokens) for images that require signed URLs.
 *
 * Cloudflare allows at most **two** keys per account, supporting a
 * create-second/migrate/delete-first rotation model, and refuses to delete
 * the last remaining key. Re-PUTting an existing key name **rotates** (i.e.
 * regenerates) its value, so this resource is existence-only: once the key
 * exists, redeploys never re-PUT and the key material stays stable.
 *
 * Requires the Cloudflare Images subscription; accounts without it receive
 * the typed `ImagesAccessNotEnabled` error.
 * @resource
 * @product Images
 * @category Media
 * @section Creating a Signing Key
 * @example Key with a generated name
 * ```typescript
 * const key = yield* Cloudflare.Images.SigningKey("UrlSigner", {});
 * ```
 *
 * @example Key with an explicit name
 * ```typescript
 * const key = yield* Cloudflare.Images.SigningKey("UrlSigner", {
 *   name: "my-app-signer",
 * });
 * ```
 *
 * @section Using the key
 * @example Signing image delivery URLs server-side
 * ```typescript
 * // The key material is redacted — pass it to your URL signer:
 * const secret = key.value; // Redacted<string>
 * ```
 *
 * @see https://developers.cloudflare.com/images/manage-images/serve-images/serve-private-images/
 */
export const SigningKey = Resource<SigningKey>(TypeId);

/**
 * Returns true if the given value is an SigningKey resource.
 */
export const isSigningKey = (value: unknown): value is SigningKey =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SigningKeyProvider = () =>
  Provider.succeed(SigningKey, {
    stables: ["keyName", "accountId", "value"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      // News may still contain unresolved plan-time expressions — defer to
      // the engine's default update logic until everything is concrete.
      if (!isResolved(news)) return undefined;
      // The key name is its PUT path identifier — it cannot be renamed.
      // Only compare when the old name is knowable; a generated name is
      // stable across deploys so an omitted name never replaces.
      const oldName = output?.keyName ?? olds?.name;
      if (
        oldName !== undefined &&
        news.name !== undefined &&
        news.name !== oldName
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof olds?.accountId === "string" &&
        typeof news.accountId === "string" &&
        olds.accountId !== news.accountId
      ) {
        return { action: "replace" } as const;
      }
      if (
        output?.accountId !== undefined &&
        typeof news.accountId === "string" &&
        news.accountId !== output.accountId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct =
        output?.accountId ??
        (olds?.accountId as string | undefined) ??
        accountId;
      const name = output?.keyName ?? (yield* createKeyName(id, olds?.name));

      const observed = yield* findKey(acct, name);
      if (!observed) return undefined;
      const attrs = toAttributes(observed, acct);
      // Signing keys carry no ownership markers. With no prior output we
      // cannot prove we created a same-named key — report it `Unowned` so
      // the engine gates takeover behind the adopt policy.
      return output?.keyName ? attrs : Unowned(attrs);
    }),

    // Account-scoped collection (Cloudflare caps it at two keys per
    // account). The non-paginated `listV1Keys` returns the whole set in one
    // call; map each entry to the same Attributes shape `read` produces.
    // Accounts without the Images signing-keys entitlement have no keys to
    // enumerate — treat as an empty set rather than a hard failure.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* images.listV1Keys({ accountId }).pipe(
        Effect.map((response): SigningKeyAttributes[] =>
          (response.keys ?? []).map((key) => toAttributes(key, accountId)),
        ),
        Effect.catchTag("ImagesAccessNotEnabled", () =>
          Effect.succeed<SigningKeyAttributes[]>([]),
        ),
      );
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const acct = (news.accountId as string | undefined) ?? accountId;
      const name = yield* createKeyName(id, news.name);

      // 1. Observe — list the account's keys and look for ours. `output`
      //    is only a cache of the name; the list is authoritative.
      let observed = yield* findKey(acct, name);

      // 2. Ensure — existence-only resource: PUT only when the key is
      //    missing. Re-PUTting an existing name would ROTATE the key
      //    material out from under consumers, so a present key is final —
      //    there is no sync step.
      if (!observed) {
        const created = yield* images.putV1Key({
          accountId: acct,
          signingKeyName: name,
        });
        observed =
          created.keys?.find((key) => key.name === name) ??
          (yield* findKey(acct, name));
      }
      if (!observed?.value) {
        // The PUT response and the follow-up list both failed to surface
        // the key — eventual-consistency blip; fail typed so the engine
        // can retry the reconcile.
        return yield* Effect.fail(
          new images.KeyNotFound({
            code: 5404,
            message: `signing key ${name} not observable after create`,
          }),
        );
      }

      return toAttributes(observed, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Note: Cloudflare refuses to delete the last remaining signing key —
      // that error is surfaced as-is (non-retryable) rather than swallowed.
      yield* images
        .deleteV1Key({
          accountId: output.accountId,
          signingKeyName: output.keyName,
        })
        .pipe(Effect.catchTag("KeyNotFound", () => Effect.void));
    }),
  });

type ObservedKey = { name?: string | null; value?: string | null };

/**
 * Find a signing key by exact name in the account's key list. Returns
 * `undefined` when absent.
 */
const findKey = (accountId: string, name: string) =>
  images
    .listV1Keys({ accountId })
    .pipe(
      Effect.map((response) =>
        (response.keys ?? []).find(
          (key): key is ObservedKey => key.name === name,
        ),
      ),
    );

const createKeyName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  key: ObservedKey,
  accountId: string,
): SigningKeyAttributes => ({
  keyName: key.name ?? "",
  accountId,
  value: Redacted.make(key.value ?? ""),
});
