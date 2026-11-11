/**
 * The ACME issuance flow shared by the `Certificate` resource (deploy time)
 * and the `IssueCertificate` binding (runtime):
 *
 *   order → DNS-01 per authorization (present → propagated → respond →
 *   poll) → finalize with a fresh key's CSR → download → parse.
 *
 * The wire is `@distilled.cloud/acme`; this file only sequences it.
 */
import * as Acme from "@distilled.cloud/acme";
import * as acme from "@distilled.cloud/acme/acme";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { CertificateAuthority } from "./CertificateAuthority.ts";
import { waitForTxt, type PropagationOptions } from "./Dns.ts";
import type { DnsChallengeRecord, DnsSolver } from "./DnsSolver.ts";
import {
  ChallengeFailed,
  ChallengeUnsupported,
  OrderInvalid,
  OrderTimeout,
  PkiError,
  type DnsPropagationTimeout,
  type DnsSolverError,
} from "./Errors.ts";
import {
  createCsr,
  csrToBase64Url,
  fromPem,
  generateKey,
  parseCertificate,
  privateKeyToJwk,
  splitPemChain,
  type KeyAlgorithm,
  type ParsedCertificate,
} from "./Pki.ts";

/** Everything the flow needs to sign requests as an account. */
export interface AccountCredentials {
  readonly ca: CertificateAuthority;
  /** The account's private JWK (JSON). */
  readonly accountKey: Redacted.Redacted<string>;
  /** The account URL (`kid`), once the account exists. */
  readonly accountUrl?: string | undefined;
  readonly externalAccountBinding?:
    | { readonly keyId: string; readonly hmacKey: Redacted.Redacted<string> }
    | undefined;
}

/**
 * The SDK's `Credentials` (+ a CA-trusting `HttpClient` for private CAs)
 * for one account. Provide around any `@distilled.cloud/acme` call.
 */
export const accountLayer = (
  credentials: AccountCredentials,
): Layer.Layer<Acme.Credentials | HttpClient.HttpClient> => {
  const creds = Acme.layer({
    directoryUrl: credentials.ca.directoryUrl,
    accountKey: credentials.accountKey,
    accountUrl: credentials.accountUrl,
    externalAccountBinding: credentials.externalAccountBinding,
  });
  const http =
    credentials.ca.trustedRoot === undefined
      ? FetchHttpClient.layer
      : FetchHttpClient.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(FetchHttpClient.RequestInit, {
              // Bun's fetch honours `tls`; the option is ignored elsewhere.
              tls: { ca: credentials.ca.trustedRoot },
            } as RequestInit),
          ),
        );
  return Layer.merge(creds, http);
};

export interface IssueRequest<R = never> {
  /** DNS names; the first is the subject CN. Wildcards allowed. */
  readonly identifiers: ReadonlyArray<string>;
  readonly solver: DnsSolver<R>;
  /** @default "ES256" */
  readonly keyAlgorithm?: KeyAlgorithm | undefined;
  /** Issuer name (`CN=...` substring) to prefer when the CA offers alternate chains. */
  readonly preferredChain?: string | undefined;
  readonly propagation?: PropagationOptions | undefined;
}

export interface IssuedCertificate {
  /** Leaf certificate PEM. */
  readonly certificate: string;
  /** Full chain PEM, leaf first. */
  readonly chain: string;
  /** PKCS#8 private key PEM. */
  readonly privateKey: Redacted.Redacted<string>;
  readonly identifiers: ReadonlyArray<string>;
  readonly serial: string;
  /** ISO 8601. */
  readonly notBefore: string;
  /** ISO 8601. */
  readonly notAfter: string;
  readonly issuer: string;
  /** The CA's certificate URL (for re-download and revocation bookkeeping). */
  readonly certificateUrl: string;
  readonly orderUrl: string;
}

export type IssueError =
  | OrderInvalid
  | ChallengeFailed
  | ChallengeUnsupported
  | OrderTimeout
  | DnsPropagationTimeout
  | DnsSolverError
  | PkiError
  | Acme.JoseError
  | acme.NewOrderError
  | acme.GetAuthorizationError
  | acme.RespondChallengeError
  | acme.FinalizeOrderError
  | acme.GetOrderError
  | acme.DownloadCertificateError;

const PENDING = new Set(["pending", "processing", "ready"]);

const challengeFqdn = (identifier: string): string =>
  `_acme-challenge.${identifier.replace(/^\*\./, "")}`;

const problemsOf = (
  order: acme.OrderResponse,
  authorizations: ReadonlyArray<acme.Authorization>,
) => {
  const problems: Array<{
    identifier?: string;
    type?: string;
    detail?: string;
  }> = [];
  if (order.error) {
    problems.push({ type: order.error.type, detail: order.error.detail });
  }
  for (const authorization of authorizations) {
    for (const challenge of authorization.challenges) {
      if (challenge.error) {
        problems.push({
          identifier: authorization.identifier.value,
          type: challenge.error.type,
          detail: challenge.error.detail,
        });
      }
    }
  }
  return problems;
};

/**
 * Complete one DNS-01 authorization and remove its TXT record on every exit.
 */
const solveAuthorization = <R>(
  authorizationUrl: string,
  jwk: Acme.Jose.Jwk,
  solver: DnsSolver<R>,
  propagation: PropagationOptions,
) =>
  Effect.gen(function* () {
    const authorization = yield* acme.getAuthorization({
      url: authorizationUrl,
    });
    if (authorization.status === "valid") return authorization;
    const identifier = authorization.identifier.value;
    const challenge = authorization.challenges.find((c) => c.type === "dns-01");
    if (challenge === undefined || challenge.token === undefined) {
      return yield* new ChallengeUnsupported({
        identifier,
        offered: authorization.challenges.map((c) => c.type),
      });
    }
    const record: DnsChallengeRecord = {
      fqdn: challengeFqdn(identifier),
      value: yield* Acme.Jose.dnsChallengeValue(challenge.token, jwk),
    };
    return yield* Effect.acquireUseRelease(
      solver.present(record),
      () =>
        Effect.gen(function* () {
          yield* solver.propagated === undefined
            ? waitForTxt(record.fqdn, record.value, propagation)
            : solver.propagated(record, propagation);
          yield* acme.respondChallenge({ url: challenge.url });
          const settled = yield* acme.getAuthorization({ url: authorizationUrl }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (a) => !PENDING.has(a.status),
              times: 8,
            }),
          );
          if (settled.status !== "valid") {
            const failed = settled.challenges.find((c) => c.type === "dns-01");
            return yield* new ChallengeFailed({
              identifier,
              type: failed?.error?.type,
              detail: failed?.error?.detail ?? `authorization is ${settled.status}`,
            });
          }
          return settled;
        }),
      () => solver.cleanup(record),
    );
  });

const chooseChain = (
  downloaded: { chain: string; alternates?: ReadonlyArray<string> },
  preferredChain: string | undefined,
) =>
  Effect.gen(function* () {
    const matches = (chain: string) =>
      Effect.gen(function* () {
        const blocks = splitPemChain(chain);
        const top = blocks[blocks.length - 1];
        if (top === undefined) return false;
        const parsed = yield* parseCertificate(top).pipe(Effect.orElseSucceed(() => undefined));
        return parsed?.issuer.includes(preferredChain!) === true;
      });
    if (preferredChain === undefined) return downloaded.chain;
    if (yield* matches(downloaded.chain)) return downloaded.chain;
    for (const url of downloaded.alternates ?? []) {
      const alternate = yield* acme.downloadCertificate({ url });
      if (yield* matches(alternate.chain)) return alternate.chain;
    }
    return downloaded.chain;
  });

/**
 * Issue a certificate for `identifiers` as the current `Credentials`
 * account. Requires the SDK's `Credentials` and an `HttpClient` (see
 * {@link accountLayer}) plus whatever the solver needs.
 */
export const issueCertificate = <R = never>(
  request: IssueRequest<R>,
): Effect.Effect<IssuedCertificate, IssueError, Acme.Credentials | HttpClient.HttpClient | R> =>
  Effect.gen(function* () {
    const resolve = yield* Acme.Credentials;
    const config = yield* resolve;
    const jwk = yield* Acme.Jose.parseJwk(config.accountKey);
    const propagation = request.propagation ?? {};

    const order = yield* acme.newOrder({
      identifiers: request.identifiers.map((value) => ({ type: "dns", value })),
    });
    if (order.location === undefined) {
      return yield* new OrderInvalid({
        orderUrl: order.finalize,
        problems: [{ detail: "The CA omitted the order Location header." }],
      });
    }
    const orderUrl = order.location;

    // Each authorization removes its own TXT record on success or failure.
    const authorizations = yield* Effect.forEach(
      order.authorizations,
      (url) => solveAuthorization(url, jwk, request.solver, propagation),
      { concurrency: 4 },
    );

    const ready = yield* acme.getOrder({ url: orderUrl }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (value) => value.status !== "pending",
        times: 8,
      }),
    );
    if (ready.status === "invalid") {
      return yield* new OrderInvalid({
        orderUrl,
        problems: problemsOf(ready, authorizations),
      });
    }
    if (ready.status !== "ready") {
      return yield* new OrderTimeout({ orderUrl, status: ready.status });
    }
    const key = yield* generateKey(request.keyAlgorithm ?? "ES256");
    const csr = yield* createCsr({ key, identifiers: request.identifiers });
    yield* acme.finalizeOrder({ url: order.finalize, csr: csrToBase64Url(csr) }).pipe(
      Effect.retry({
        while: (error) => error._tag === "AcmeOrderNotReady",
        schedule: Schedule.spaced("1 second"),
        times: 8,
      }),
    );

    const settled = yield* acme.getOrder({ url: orderUrl }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (o) => o.status === "valid" || o.status === "invalid",
        times: 8,
      }),
    );
    if (settled.status === "invalid") {
      return yield* new OrderInvalid({
        orderUrl,
        problems: problemsOf(settled, authorizations),
      });
    }
    if (settled.status !== "valid" || settled.certificate === undefined) {
      return yield* new OrderTimeout({ orderUrl, status: settled.status });
    }

    const downloaded = yield* acme.downloadCertificate({
      url: settled.certificate,
    });
    const chain = yield* chooseChain(downloaded, request.preferredChain);
    const certificate = splitPemChain(chain)[0] ?? chain;
    const parsed = yield* parseCertificate(certificate);
    return toIssued({
      certificate,
      chain,
      privateKey: key.privateKeyPem,
      identifiers: request.identifiers,
      certificateUrl: settled.certificate,
      orderUrl,
      parsed,
    });
  });

const toIssued = (input: {
  certificate: string;
  chain: string;
  privateKey: Redacted.Redacted<string>;
  identifiers: ReadonlyArray<string>;
  certificateUrl: string;
  orderUrl: string;
  parsed: ParsedCertificate;
}): IssuedCertificate => ({
  certificate: input.certificate,
  chain: input.chain,
  privateKey: input.privateKey,
  identifiers: input.identifiers,
  serial: input.parsed.serial,
  notBefore: input.parsed.notBefore.toISOString(),
  notAfter: input.parsed.notAfter.toISOString(),
  issuer: input.parsed.issuer,
  certificateUrl: input.certificateUrl,
  orderUrl: input.orderUrl,
});

/** RFC 5280 revocation reasons. */
export type RevocationReason =
  | "unspecified"
  | "keyCompromise"
  | "affiliationChanged"
  | "superseded"
  | "cessationOfOperation";

const REASON_CODES: Record<RevocationReason, number> = {
  unspecified: 0,
  keyCompromise: 1,
  affiliationChanged: 3,
  superseded: 4,
  cessationOfOperation: 5,
};

export interface RevokeRequest {
  /** Leaf certificate PEM. */
  readonly certificate: string;
  /**
   * The certificate's private key. When given, the request is signed with
   * it (RFC 8555 §7.6) so no account is needed; otherwise the ambient
   * account credentials sign.
   */
  readonly privateKey?: Redacted.Redacted<string> | string | undefined;
  readonly reason?: RevocationReason | undefined;
}

export type RevokeError = PkiError | acme.RevokeCertificateError;

/** Revoke a certificate. `AcmeAlreadyRevoked` is folded into success. */
export const revokeCertificate = (
  request: RevokeRequest,
): Effect.Effect<void, RevokeError, Acme.Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const leaf = splitPemChain(request.certificate)[0] ?? request.certificate;
    const der = yield* Effect.try({
      try: () => fromPem(leaf),
      catch: (cause) => new PkiError({ message: "The certificate is not PEM.", cause }),
    });
    const revoke = acme
      .revokeCertificate({
        certificate: Acme.Jose.base64url(der),
        reason: request.reason === undefined ? undefined : REASON_CODES[request.reason],
      })
      .pipe(Effect.catchTag("AcmeAlreadyRevoked", () => Effect.void));
    if (request.privateKey === undefined) {
      return yield* revoke;
    }
    // Sign with the certificate key (RFC 8555 §7.6): swap the account key
    // and drop the account URL so the protocol embeds the JWK.
    const resolve = yield* Acme.Credentials;
    const config = yield* resolve;
    const jwk = yield* privateKeyToJwk(request.privateKey);
    return yield* revoke.pipe(
      Effect.provide(Acme.layer({ directoryUrl: config.directoryUrl, accountKey: jwk })),
    );
  });
