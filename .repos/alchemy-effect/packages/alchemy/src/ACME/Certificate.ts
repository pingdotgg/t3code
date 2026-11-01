import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { arrayEqualsUnordered } from "../Util/equal.ts";
import type { Account } from "./Account.ts";
import {
  accountLayer,
  issueCertificate,
  revokeCertificate,
  type AccountCredentials,
} from "./Client.ts";
import type { PropagationOptions } from "./Dns.ts";
import { resolveDnsSolver, type DnsSolverDescriptor } from "./DnsSolver.ts";
import type { KeyAlgorithm } from "./Pki.ts";
import type { Providers } from "./Providers.ts";

export interface CertificateProps {
  /** The {@link Account} that orders the certificate. Changing it replaces. */
  account: Account;
  /**
   * DNS names the certificate covers. The first is the subject CN;
   * wildcards (`*.example.com`) are allowed. Changing the set re-issues.
   */
  identifiers: string[];
  /**
   * How `_acme-challenge` TXT records are published, e.g.
   * `Cloudflare.DNS.AcmeSolver(zone)`. Changing the solver alone does not
   * re-issue.
   */
  solver: DnsSolverDescriptor;
  /**
   * Certificate key algorithm. Changing it re-issues the certificate.
   * @default "ES256"
   */
  keyAlgorithm?: KeyAlgorithm;
  /**
   * Re-issue when less than this remains before `notAfter`. Renewal is a
   * `diff` result, so any `alchemy deploy` (a scheduled one, typically)
   * renews.
   * @default "30 days"
   */
  renewBefore?: Duration.Input;
  /**
   * Revoke the certificate at the CA when the resource is deleted. By
   * default deletion only forgets the certificate.
   * @default false
   */
  revokeOnDelete?: boolean;
  /**
   * Issuer name to prefer (`CN=…` substring, e.g. `ISRG Root X1`) when the
   * CA offers alternate chains.
   */
  preferredChain?: string;
  /** DNS propagation polling (resolvers, timeout, interval). */
  propagation?: PropagationOptions;
}

export interface Certificate extends Resource<
  "ACME.Certificate",
  CertificateProps,
  {
    /** Leaf certificate PEM. */
    certificate: string;
    /** Full chain PEM, leaf first. */
    chain: string;
    /** PKCS#8 private key PEM. Sensitive; persisted in stack state. */
    privateKey: Redacted.Redacted<string>;
    /** Serial number, hex. */
    serial: string;
    /** ISO 8601 validity start. */
    notBefore: string;
    /** ISO 8601 expiry. Renewal is scheduled against it. */
    notAfter: string;
    /** Issuer distinguished name. */
    issuer: string;
    /** The DNS names covered. */
    identifiers: string[];
    /** The CA's certificate URL. */
    certificateUrl: string;
    /** The CA's order URL. */
    orderUrl: string;
    /** Key algorithm of `privateKey`. */
    keyAlgorithm: KeyAlgorithm;
    /** The account that issued the certificate. */
    accountUrl: string;
    /** The CA the certificate was issued by (for revocation on delete). */
    directoryUrl: string;
    /** PEM root trusted for the CA's endpoint (private CAs only). */
    trustedRoot: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A TLS certificate issued over ACME at deploy time, with renewal.
 *
 * Reconcile places an order, proves control of every name over DNS-01
 * through the `solver`, finalizes with a fresh key's CSR and stores the
 * chain and redacted private key in state. Protect the state store as
 * secret material. `diff` reports an update when the
 * names change or when `renewBefore` of validity remains, so a scheduled
 * `alchemy deploy` keeps certificates fresh.
 *
 * ### Wildcard certificate
 * **Example:** Let's Encrypt wildcard over Cloudflare DNS
 * ```typescript
 * const account = yield* ACME.Account("Issuer", {
 *   ca: ACME.LetsEncrypt,
 *   termsOfServiceAgreed: true,
 * });
 * const zone = yield* Zone;
 * const wildcard = yield* ACME.Certificate("Wildcard", {
 *   account,
 *   identifiers: ["*.example.com", "example.com"],
 *   solver: Cloudflare.DNS.AcmeSolver(zone),
 * });
 * ```
 *
 * ### Using the certificate
 * The chain and key are Outputs — pass them to whatever terminates TLS.
 *
 * **Example:** Upload to a Fly App
 * ```typescript
 * const www = yield* Fly.Certificate("Www", {
 *   app: Site,
 *   hostname: "www.example.com",
 *   kind: "custom",
 *   fullchain: wildcard.chain,
 *   privateKey: wildcard.privateKey,
 * });
 * ```
 *
 * ### Renewal
 * **Example:** Renew earlier and revoke on delete
 * ```typescript
 * const api = yield* ACME.Certificate("Api", {
 *   account,
 *   identifiers: ["api.example.com"],
 *   solver: Cloudflare.DNS.AcmeSolver(zone),
 *   renewBefore: "45 days",
 *   revokeOnDelete: true,
 * });
 * ```
 *
 * @resource
 * @product Certificate
 * @category Certificates
 */
export const Certificate = Resource<Certificate>("ACME.Certificate");

type AccountRef = {
  directoryUrl: string;
  trustedRoot?: string | undefined;
  accountUrl: string;
  privateKey: Redacted.Redacted<string>;
};

/** The resolved account attributes behind a resource-valued prop. */
const accountOf = (value: unknown): AccountRef => value as AccountRef;

const credentialsOf = (account: AccountRef): AccountCredentials => ({
  ca: { directoryUrl: account.directoryUrl, trustedRoot: account.trustedRoot },
  accountKey: account.privateKey,
  accountUrl: account.accountUrl,
});

const DEFAULT_RENEW_BEFORE: Duration.Input = "30 days";

const renewalDue = (
  notAfter: string,
  renewBefore: Duration.Input | undefined,
  now: number,
): boolean =>
  Date.parse(notAfter) - now <
  Duration.toMillis(renewBefore ?? DEFAULT_RENEW_BEFORE);

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["directoryUrl"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (news === undefined || !isResolved(news) || output === undefined) {
        return undefined;
      }
      const account = accountOf(news.account);
      if (account.accountUrl !== output.accountUrl) {
        return { action: "replace" as const };
      }
      const now = yield* Effect.sync(() => Date.now());
      const reissue =
        !arrayEqualsUnordered(news.identifiers, output.identifiers) ||
        (news.keyAlgorithm ?? "ES256") !== output.keyAlgorithm ||
        news.preferredChain !== olds?.preferredChain ||
        renewalDue(output.notAfter, news.renewBefore, now);
      return reissue ? { action: "update" as const } : undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      return output;
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const account = accountOf(news.account);
      const keyAlgorithm = news.keyAlgorithm ?? "ES256";
      const now = yield* Effect.sync(() => Date.now());
      // Observe: the stored certificate is authoritative — nothing to do
      // while it covers the names and isn't due.
      if (
        output !== undefined &&
        output.accountUrl === account.accountUrl &&
        arrayEqualsUnordered(news.identifiers, output.identifiers) &&
        output.keyAlgorithm === keyAlgorithm &&
        news.preferredChain === olds?.preferredChain &&
        !renewalDue(output.notAfter, news.renewBefore, now)
      ) {
        return {
          ...output,
          directoryUrl: account.directoryUrl,
          trustedRoot: account.trustedRoot,
        };
      }
      const solver = yield* resolveDnsSolver(news.solver);
      const issued = yield* issueCertificate({
        identifiers: news.identifiers,
        solver,
        keyAlgorithm,
        preferredChain: news.preferredChain,
        propagation: news.propagation,
      }).pipe(Effect.provide(accountLayer(credentialsOf(account))));
      return {
        certificate: issued.certificate,
        chain: issued.chain,
        privateKey: issued.privateKey,
        serial: issued.serial,
        notBefore: issued.notBefore,
        notAfter: issued.notAfter,
        issuer: issued.issuer,
        identifiers: [...news.identifiers],
        certificateUrl: issued.certificateUrl,
        orderUrl: issued.orderUrl,
        keyAlgorithm,
        accountUrl: account.accountUrl,
        directoryUrl: account.directoryUrl,
        trustedRoot: account.trustedRoot,
      };
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (olds.revokeOnDelete !== true) return;
      const account = accountOf(olds.account);
      // Signed with the certificate's own key, so revocation works even
      // after the account was replaced or deactivated.
      yield* revokeCertificate({
        certificate: output.certificate,
        privateKey: output.privateKey,
        reason: "cessationOfOperation",
      }).pipe(
        Effect.provide(
          accountLayer({
            ca: {
              directoryUrl: output.directoryUrl,
              trustedRoot: output.trustedRoot,
            },
            accountKey: account.privateKey,
            accountUrl: account.accountUrl,
          }),
        ),
      );
    }),
  });
