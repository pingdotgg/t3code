import * as Acme from "@distilled.cloud/acme";
import * as acme from "@distilled.cloud/acme/acme";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";
import { accountLayer, type AccountCredentials } from "./Client.ts";
import type { KeyAlgorithm } from "./Pki.ts";
import type { Providers } from "./Providers.ts";

export interface ExternalAccountBinding {
  /** The key id the CA issued (ZeroSSL: `eab_kid`). */
  keyId: string;
  /** The base64url HMAC key the CA issued (ZeroSSL: `eab_hmac_key`). */
  hmacKey: Redacted.Redacted<string> | string;
}

export interface AccountProps {
  /**
   * The certificate authority: a preset ({@link LetsEncrypt},
   * {@link ZeroSSL}, …) or `{ directoryUrl }`. Changing it replaces the
   * account.
   */
  ca: CertificateAuthority;
  /**
   * Contact URLs (`mailto:…`) the CA notifies about expiry and incidents.
   * Updated in place.
   */
  contact?: string[];
  /**
   * You must agree to the CA's terms of service. Explicit on purpose —
   * never defaulted.
   */
  termsOfServiceAgreed: true;
  /**
   * External Account Binding for CAs that require one (ZeroSSL, Google
   * Trust Services). Changing the key id replaces the account.
   */
  eab?: ExternalAccountBinding;
  /**
   * Account key algorithm. Changing it replaces the account.
   * @default "ES256"
   */
  keyAlgorithm?: KeyAlgorithm;
}

export interface Account extends Resource<
  "ACME.Account",
  AccountProps,
  {
    /** The CA's directory URL. */
    directoryUrl: string;
    /** PEM root trusted for the CA's HTTPS endpoint (private CAs only). */
    trustedRoot: string | undefined;
    /** The account URL the CA assigned — the `kid` on every later request. */
    accountUrl: string;
    /** Observed account status (`valid`, `deactivated`, `revoked`). */
    status: string;
    /** Observed contact URLs. */
    contact: string[];
    /** Account key algorithm. */
    keyAlgorithm: KeyAlgorithm;
    /** The account's private JWK (JSON). Sensitive; persisted in stack state. */
    privateKey: Redacted.Redacted<string>;
  },
  never,
  Providers
> {}

/**
 * An ACME account with a certificate authority — the identity that every
 * {@link Certificate} and every runtime {@link IssueCertificate} call
 * signs with. One per CA per stack.
 *
 * The account key is generated on first reconcile and persisted as a
 * redacted value alongside the CA's account URL. Protect the state store
 * as secret material; redaction alone does not encrypt the storage backend.
 *
 * ### Let's Encrypt
 * **Example:** An account with Let's Encrypt
 * ```typescript
 * export const LetsEncrypt = ACME.Account("LetsEncrypt", {
 *   ca: ACME.LetsEncrypt,
 *   contact: ["mailto:ops@example.com"],
 *   termsOfServiceAgreed: true,
 * });
 * ```
 *
 * ### External Account Binding
 * ZeroSSL and Google Trust Services bind ACME accounts to an existing
 * customer account with a key id + HMAC pair from their dashboard (ZeroSSL
 * also mints them over its REST API — see `@distilled.cloud/zerossl`).
 *
 * **Example:** ZeroSSL
 * ```typescript
 * export const ZeroSsl = ACME.Account("ZeroSSL", {
 *   ca: ACME.ZeroSSL,
 *   eab: {
 *     keyId: Config.String("ZEROSSL_EAB_KID"),
 *     hmacKey: Config.Redacted("ZEROSSL_EAB_HMAC_KEY"),
 *   },
 *   termsOfServiceAgreed: true,
 * });
 * ```
 *
 * ### Private CAs
 * A private CA (Pebble, step-ca) whose HTTPS certificate is not publicly
 * trusted passes its root as `trustedRoot`.
 *
 * **Example:** Pebble
 * ```typescript
 * export const Pebble = ACME.Account("Pebble", {
 *   ca: { directoryUrl: "https://localhost:14000/dir", trustedRoot: pebbleRootPem },
 *   termsOfServiceAgreed: true,
 * });
 * ```
 *
 * @resource
 * @product Account
 * @category Certificates
 */
export const Account = Resource<Account>("ACME.Account");

/** The CA answered `newAccount` without a `Location`, so the account has no URL. */
export class AccountUrlMissing extends Data.TaggedError(
  "ACME.AccountUrlMissing",
)<{
  readonly directoryUrl: string;
}> {}

/**
 * Normalize to exactly one `Redacted` layer: a value that already came
 * redacted (an SDK's sensitive field) wrapped again by the caller would
 * otherwise sign with an object instead of the key.
 */
const unwrap = (value: Redacted.Redacted<string> | string) => {
  let inner: unknown = value;
  while (Redacted.isRedacted(inner)) inner = Redacted.value(inner);
  return Redacted.make(String(inner));
};

const credentialsOf = (
  props: Pick<AccountProps, "ca" | "eab">,
  accountKey: Redacted.Redacted<string>,
  accountUrl: string | undefined,
): AccountCredentials => ({
  ca: props.ca,
  accountKey,
  accountUrl,
  externalAccountBinding:
    props.eab === undefined
      ? undefined
      : { keyId: props.eab.keyId, hmacKey: unwrap(props.eab.hmacKey) },
});

/** `newAccount` with `onlyReturnExisting` — the account, or `undefined`. */
const observeAccount = (credentials: AccountCredentials) =>
  acme.newAccount({ onlyReturnExisting: true }).pipe(
    Effect.catchTag("AcmeAccountDoesNotExist", () => Effect.succeed(undefined)),
    Effect.provide(accountLayer(credentials)),
  );

const sameContacts = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["directoryUrl", "accountUrl", "keyAlgorithm", "privateKey"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (news === undefined || !isResolved(news) || output === undefined) {
        return undefined;
      }
      if (
        news.ca.directoryUrl !== output.directoryUrl ||
        (news.keyAlgorithm ?? "ES256") !== output.keyAlgorithm ||
        news.eab?.keyId !== olds?.eab?.keyId
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined || olds === undefined) return undefined;
      const credentials = credentialsOf(
        olds,
        output.privateKey,
        output.accountUrl,
      );
      const existing = yield* observeAccount(credentials);
      if (existing === undefined) return undefined;
      return {
        ...output,
        status: existing.status,
        contact: existing.contact ?? [],
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const keyAlgorithm = news.keyAlgorithm ?? "ES256";
      // Observe: the key is the identity; keep it across reconciles.
      const accountKey =
        output?.privateKey ??
        (yield* Acme.Jose.generateAccountKey(keyAlgorithm));
      const credentials = credentialsOf(news, accountKey, output?.accountUrl);
      let account = yield* observeAccount(credentials);

      // Repeating newAccount with the same key returns the existing account.
      if (account === undefined) {
        account = yield* acme
          .newAccount({
            contact: news.contact,
            termsOfServiceAgreed: true,
          })
          .pipe(Effect.provide(accountLayer(credentials)));
      }
      const accountUrl = account.location ?? output?.accountUrl;
      if (accountUrl === undefined) {
        return yield* new AccountUrlMissing({
          directoryUrl: news.ca.directoryUrl,
        });
      }

      // Sync: contacts are the only mutable aspect.
      const withKid = accountLayer(credentialsOf(news, accountKey, accountUrl));
      if (!sameContacts(news.contact, account.contact)) {
        account = yield* acme
          .updateAccount({ url: accountUrl, contact: news.contact ?? [] })
          .pipe(Effect.provide(withKid));
      }

      return {
        directoryUrl: news.ca.directoryUrl,
        trustedRoot: news.ca.trustedRoot,
        accountUrl,
        status: account.status,
        contact: account.contact ?? [],
        keyAlgorithm,
        privateKey: accountKey,
      };
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const credentials = credentialsOf(
        olds,
        output.privateKey,
        output.accountUrl,
      );
      // Deactivation is permanent and idempotent: a deactivated account
      // answers `unauthorized`, a purged one `accountDoesNotExist`.
      yield* acme
        .updateAccount({ url: output.accountUrl, status: "deactivated" })
        .pipe(
          Effect.catchTag(["AcmeAccountDoesNotExist", "AcmeUnauthorized"], () =>
            Effect.succeed(undefined),
          ),
          Effect.provide(accountLayer(credentials)),
        );
    }),
  });
