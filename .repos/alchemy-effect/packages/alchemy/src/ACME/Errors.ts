import * as Data from "effect/Data";

/** A problem the CA attached to an order or one of its identifiers. */
export interface IdentifierProblem {
  /** The identifier the problem concerns, when the CA said. */
  readonly identifier?: string | undefined;
  /** The `urn:ietf:params:acme:error:*` type. */
  readonly type?: string | undefined;
  /** Human-readable detail from the CA. */
  readonly detail?: string | undefined;
}

/**
 * The CA moved the order to `invalid`. Carries the problem documents the
 * order and its authorizations reported, one per failed identifier where
 * the CA said which.
 */
export class OrderInvalid extends Data.TaggedError("ACME.OrderInvalid")<{
  readonly orderUrl: string;
  readonly problems: ReadonlyArray<IdentifierProblem>;
}> {
  override get message() {
    const details = this.problems
      .map((p) => [p.identifier, p.type, p.detail].filter(Boolean).join(": "))
      .join("; ");
    return `ACME order ${this.orderUrl} is invalid${details ? `: ${details}` : ""}`;
  }
}

/** The CA rejected the DNS-01 challenge for one identifier. */
export class ChallengeFailed extends Data.TaggedError("ACME.ChallengeFailed")<{
  readonly identifier: string;
  readonly type?: string | undefined;
  readonly detail?: string | undefined;
}> {
  override get message() {
    return `DNS-01 challenge for ${this.identifier} failed${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** The CA offered no `dns-01` challenge for an identifier. */
export class ChallengeUnsupported extends Data.TaggedError(
  "ACME.ChallengeUnsupported",
)<{
  readonly identifier: string;
  readonly offered: ReadonlyArray<string>;
}> {
  override get message() {
    return `The CA offered no dns-01 challenge for ${this.identifier} (offered: ${this.offered.join(", ") || "none"})`;
  }
}

/** The order never reached a terminal state within the polling budget. */
export class OrderTimeout extends Data.TaggedError("ACME.OrderTimeout")<{
  readonly orderUrl: string;
  readonly status: string;
}> {
  override get message() {
    return `ACME order ${this.orderUrl} is still "${this.status}" after the polling budget`;
  }
}

/** The `_acme-challenge` TXT record never became visible to public resolvers. */
export class DnsPropagationTimeout extends Data.TaggedError(
  "ACME.DnsPropagationTimeout",
)<{
  readonly fqdn: string;
  readonly value: string;
}> {
  override get message() {
    return `TXT ${this.fqdn} did not propagate within the wait budget`;
  }
}

/** A DNS solver could not publish or remove a challenge record. */
export class DnsSolverError extends Data.TaggedError("ACME.DnsSolverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A solver descriptor names a `type` no registered DNS provider handles. */
export class DnsSolverNotRegistered extends Data.TaggedError(
  "ACME.DnsSolverNotRegistered",
)<{
  readonly type: string;
}> {
  override get message() {
    return `No DNS-01 solver is registered for "${this.type}". Include the DNS provider's providers() layer (e.g. Cloudflare.providers()) in the stack.`;
  }
}

/** Key generation, CSR encoding or certificate parsing failed. */
export class PkiError extends Data.TaggedError("ACME.PkiError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
