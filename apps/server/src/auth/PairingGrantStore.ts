import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type ServerAuthBootstrapMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt: DateTime.DateTime;
}

export class UnknownBootstrapCredentialError extends Schema.TaggedErrorClass<UnknownBootstrapCredentialError>()(
  "UnknownBootstrapCredentialError",
  {
    reason: Schema.Literal("unknown"),
  },
) {
  override get message(): string {
    return "Unknown bootstrap credential.";
  }
}

export class ExpiredBootstrapCredentialError extends Schema.TaggedErrorClass<ExpiredBootstrapCredentialError>()(
  "ExpiredBootstrapCredentialError",
  {
    reason: Schema.Literal("expired"),
  },
) {
  override get message(): string {
    return "Bootstrap credential expired.";
  }
}

export class BootstrapCredentialProofKeyMismatchError extends Schema.TaggedErrorClass<BootstrapCredentialProofKeyMismatchError>()(
  "BootstrapCredentialProofKeyMismatchError",
  {
    reason: Schema.Literal("proof_key_mismatch"),
  },
) {
  override get message(): string {
    return "Bootstrap credential proof key mismatch.";
  }
}

export class UnavailableBootstrapCredentialError extends Schema.TaggedErrorClass<UnavailableBootstrapCredentialError>()(
  "UnavailableBootstrapCredentialError",
  {
    reason: Schema.Literal("unavailable"),
  },
) {
  override get message(): string {
    return "Bootstrap credential is no longer available.";
  }
}

export const BootstrapCredentialInvalidError = Schema.Union([
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
  BootstrapCredentialProofKeyMismatchError,
  UnavailableBootstrapCredentialError,
]);
export type BootstrapCredentialInvalidError = typeof BootstrapCredentialInvalidError.Type;
export const isBootstrapCredentialInvalidError = Schema.is(BootstrapCredentialInvalidError);

export class ActivePairingLinksLoadError extends Schema.TaggedErrorClass<ActivePairingLinksLoadError>()(
  "ActivePairingLinksLoadError",
  {
    operation: Schema.Literal("list_active"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load active pairing links.";
  }
}

export class PairingLinkRevokeError extends Schema.TaggedErrorClass<PairingLinkRevokeError>()(
  "PairingLinkRevokeError",
  {
    operation: Schema.Literal("revoke"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to revoke pairing link.";
  }
}

export class PairingCredentialIssueError extends Schema.TaggedErrorClass<PairingCredentialIssueError>()(
  "PairingCredentialIssueError",
  {
    operation: Schema.Literal("issue"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to issue pairing credential.";
  }
}

export class BootstrapCredentialConsumeError extends Schema.TaggedErrorClass<BootstrapCredentialConsumeError>()(
  "BootstrapCredentialConsumeError",
  {
    operation: Schema.Literal("consume"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to consume bootstrap credential.";
  }
}

export const BootstrapCredentialInternalError = Schema.Union([
  ActivePairingLinksLoadError,
  PairingLinkRevokeError,
  PairingCredentialIssueError,
  BootstrapCredentialConsumeError,
]);
export type BootstrapCredentialInternalError = typeof BootstrapCredentialInternalError.Type;
export const isBootstrapCredentialInternalError = Schema.is(BootstrapCredentialInternalError);

export const BootstrapCredentialError = Schema.Union([
  BootstrapCredentialInvalidError,
  BootstrapCredentialInternalError,
]);
export type BootstrapCredentialError = typeof BootstrapCredentialError.Type;
export const isBootstrapCredentialError = Schema.is(BootstrapCredentialError);

export interface IssuedBootstrapCredential {
  readonly id: string;
  readonly credential: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt: DateTime.Utc;
}

export type BootstrapCredentialChange =
  | {
      readonly type: "pairingLinkUpserted";
      readonly pairingLink: AuthPairingLink;
    }
  | {
      readonly type: "pairingLinkRemoved";
      readonly id: string;
    };

export class PairingGrantStore extends Context.Service<
  PairingGrantStore,
  {
    readonly issueOneTimeToken: (input?: {
      readonly ttl?: Duration.Duration;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly label?: string;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialInternalError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthPairingLink>,
      BootstrapCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
    readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly consume: (
      credential: string,
      input?: {
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
  }
>()("t3/auth/PairingGrantStore") {}

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

type ConsumeResult =
  | {
      readonly _tag: "error";
      readonly reason: "not-found" | "expired";
      readonly error: BootstrapCredentialError;
    }
  | {
      readonly _tag: "success";
      readonly grant: BootstrapGrant;
    };

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);
const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 12;
const PAIRING_TOKEN_REJECTION_LIMIT =
  Math.floor(256 / PAIRING_TOKEN_ALPHABET.length) * PAIRING_TOKEN_ALPHABET.length;

const invalidBootstrapCredentialError = (
  reason: BootstrapCredentialInvalidError["reason"],
): BootstrapCredentialInvalidError => {
  switch (reason) {
    case "unknown":
      return new UnknownBootstrapCredentialError({ reason });
    case "expired":
      return new ExpiredBootstrapCredentialError({ reason });
    case "proof_key_mismatch":
      return new BootstrapCredentialProofKeyMismatchError({ reason });
    case "unavailable":
      return new UnavailableBootstrapCredentialError({ reason });
  }
};

const internalBootstrapCredentialError = (
  operation: BootstrapCredentialInternalError["operation"],
  cause: unknown,
): BootstrapCredentialInternalError => {
  switch (operation) {
    case "list_active":
      return new ActivePairingLinksLoadError({ operation, cause });
    case "revoke":
      return new PairingLinkRevokeError({ operation, cause });
    case "issue":
      return new PairingCredentialIssueError({ operation, cause });
    case "consume":
      return new BootstrapCredentialConsumeError({ operation, cause });
  }
};

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();
  const generatePairingToken = Effect.gen(function* () {
    let credential = "";
    while (credential.length < PAIRING_TOKEN_LENGTH) {
      const bytes = yield* crypto.randomBytes(PAIRING_TOKEN_LENGTH);
      for (const byte of bytes) {
        if (byte >= PAIRING_TOKEN_REJECTION_LIMIT) {
          continue;
        }
        credential += PAIRING_TOKEN_ALPHABET[byte % PAIRING_TOKEN_ALPHABET.length]!;
        if (credential.length === PAIRING_TOKEN_LENGTH) {
          return credential;
        }
      }
    }
    return credential;
  });

  const seedGrant = (credential: string, grant: StoredBootstrapGrant) =>
    Ref.update(seededGrantsRef, (current) => {
      const next = new Map(current);
      next.set(credential, grant);
      return next;
    });

  const emitUpsert = (pairingLink: AuthPairingLink) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkUpserted",
      pairingLink,
    }).pipe(Effect.asVoid);

  const emitRemoved = (id: string) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkRemoved",
      id,
    }).pipe(Effect.asVoid);

  if (config.desktopBootstrapToken) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      scopes: AuthAdministrativeScopes,
      subject: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES),
      }),
      remainingUses: 1,
    });
  }

  const toBootstrapCredentialError =
    (operation: BootstrapCredentialInternalError["operation"]) => (cause: unknown) =>
      internalBootstrapCredentialError(operation, cause);

  const listActive: PairingGrantStore["Service"]["listActive"] = Effect.fn(
    "PairingGrantStore.listActive",
  )(
    function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });

      return rows.map((row) =>
        row.label
          ? ({
              id: row.id,
              credential: row.credential,
              scopes: row.scopes,
              subject: row.subject,
              label: row.label,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink)
          : ({
              id: row.id,
              credential: row.credential,
              scopes: row.scopes,
              subject: row.subject,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink),
      );
    },
    Effect.mapError(toBootstrapCredentialError("list_active")),
  );

  const revoke: PairingGrantStore["Service"]["revoke"] = Effect.fn("PairingGrantStore.revoke")(
    function* (id) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks.revoke({
        id,
        revokedAt,
      });
      if (revoked) {
        yield* emitRemoved(id);
      }
      return revoked;
    },
    Effect.mapError(toBootstrapCredentialError("revoke")),
  );

  const issueOneTimeToken: PairingGrantStore["Service"]["issueOneTimeToken"] = Effect.fn(
    "PairingGrantStore.issueOneTimeToken",
  )(
    function* (input) {
      const id = yield* crypto.randomUUIDv4;
      const credential = yield* generatePairingToken;
      const ttl = input?.ttl ?? DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES;
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(ttl) });
      const issued: IssuedBootstrapCredential = {
        id,
        credential,
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        expiresAt,
      };
      yield* pairingLinks.create({
        id,
        credential,
        method: "one-time-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        label: input?.label ?? null,
        proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
        createdAt: now,
        expiresAt: expiresAt,
      });
      yield* emitUpsert({
        id,
        credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
        createdAt: now,
        expiresAt,
      });
      return issued;
    },
    Effect.mapError(toBootstrapCredentialError("issue")),
  );

  const consume: PairingGrantStore["Service"]["consume"] = Effect.fn("PairingGrantStore.consume")(
    function* (credential, input) {
      const now = yield* DateTime.now;
      const seededResult: ConsumeResult = yield* Ref.modify(
        seededGrantsRef,
        (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
          const grant = current.get(credential);
          if (!grant) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: invalidBootstrapCredentialError("unknown"),
              },
              current,
            ];
          }

          const next = new Map(current);
          if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
            next.delete(credential);
            return [
              {
                _tag: "error",
                reason: "expired",
                error: invalidBootstrapCredentialError("expired"),
              },
              next,
            ];
          }

          if (grant.proofKeyThumbprint && grant.proofKeyThumbprint !== input?.proofKeyThumbprint) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: invalidBootstrapCredentialError("proof_key_mismatch"),
              },
              next,
            ];
          }

          const remainingUses = grant.remainingUses;
          if (typeof remainingUses === "number") {
            if (remainingUses <= 1) {
              next.delete(credential);
            } else {
              next.set(credential, {
                ...grant,
                remainingUses: remainingUses - 1,
              });
            }
          }

          return [
            {
              _tag: "success",
              grant: {
                method: grant.method,
                scopes: grant.scopes,
                subject: grant.subject,
                ...(grant.label ? { label: grant.label } : {}),
                ...(grant.proofKeyThumbprint
                  ? { proofKeyThumbprint: grant.proofKeyThumbprint }
                  : {}),
                expiresAt: grant.expiresAt,
              } satisfies BootstrapGrant,
            },
            next,
          ];
        },
      );

      if (seededResult._tag === "success") {
        return seededResult.grant;
      }
      if (seededResult.reason !== "not-found") {
        return yield* seededResult.error;
      }

      const consumed = yield* pairingLinks.consumeAvailable({
        credential,
        proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
        consumedAt: now,
        now,
      });

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return {
          method: consumed.value.method,
          scopes: consumed.value.scopes,
          subject: consumed.value.subject,
          ...(consumed.value.label ? { label: consumed.value.label } : {}),
          ...(consumed.value.proofKeyThumbprint
            ? { proofKeyThumbprint: consumed.value.proofKeyThumbprint }
            : {}),
          expiresAt: consumed.value.expiresAt,
        } satisfies BootstrapGrant;
      }

      const matching = yield* pairingLinks.getByCredential({ credential });
      if (Option.isNone(matching)) {
        return yield* invalidBootstrapCredentialError("unknown");
      }

      if (matching.value.revokedAt !== null) {
        return yield* invalidBootstrapCredentialError("unavailable");
      }

      if (matching.value.consumedAt !== null) {
        return yield* invalidBootstrapCredentialError("unknown");
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* invalidBootstrapCredentialError("expired");
      }

      if (
        matching.value.proofKeyThumbprint !== null &&
        matching.value.proofKeyThumbprint !== input?.proofKeyThumbprint
      ) {
        return yield* invalidBootstrapCredentialError("proof_key_mismatch");
      }

      return yield* invalidBootstrapCredentialError("unavailable");
    },
    Effect.mapError((cause) =>
      isBootstrapCredentialError(cause)
        ? cause
        : internalBootstrapCredentialError("consume", cause),
    ),
  );

  return PairingGrantStore.of({
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
  });
});

export const layer = Layer.effect(PairingGrantStore, make).pipe(
  Layer.provideMerge(AuthPairingLinks.layer),
);
