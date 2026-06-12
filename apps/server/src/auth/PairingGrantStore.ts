import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type ServerAuthBootstrapMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { AuthPairingLinkRepositoryLive } from "../persistence/Layers/AuthPairingLinks.ts";
import { AuthPairingLinkRepository } from "../persistence/Services/AuthPairingLinks.ts";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt: DateTime.DateTime;
}

export class BootstrapCredentialInvalidError extends Data.TaggedError(
  "BootstrapCredentialInvalidError",
)<{
  readonly message: string;
}> {}

export class BootstrapCredentialInternalError extends Data.TaggedError(
  "BootstrapCredentialInternalError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type BootstrapCredentialError =
  | BootstrapCredentialInvalidError
  | BootstrapCredentialInternalError;

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

export interface PairingGrantStoreShape {
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

export class PairingGrantStore extends Context.Service<PairingGrantStore, PairingGrantStoreShape>()(
  "t3/auth/PairingGrantStore",
) {}

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

const invalidBootstrapCredentialError = (message: string) =>
  new BootstrapCredentialInvalidError({
    message,
  });

const internalBootstrapCredentialError = (message: string, cause: unknown) =>
  new BootstrapCredentialInternalError({
    message,
    cause,
  });

export const make = Effect.fn("makePairingGrantStore")(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const pairingLinks = yield* AuthPairingLinkRepository;
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

  const toBootstrapCredentialError = (message: string) => (cause: unknown) =>
    internalBootstrapCredentialError(message, cause);

  const listActive: PairingGrantStoreShape["listActive"] = Effect.fn(
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
    Effect.mapError(toBootstrapCredentialError("Failed to load active pairing links.")),
  );

  const revoke: PairingGrantStoreShape["revoke"] = Effect.fn("PairingGrantStore.revoke")(
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
    Effect.mapError(toBootstrapCredentialError("Failed to revoke pairing link.")),
  );

  const issueOneTimeToken: PairingGrantStoreShape["issueOneTimeToken"] = Effect.fn(
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
    Effect.mapError(toBootstrapCredentialError("Failed to issue pairing credential.")),
  );

  const consume: PairingGrantStoreShape["consume"] = Effect.fn("PairingGrantStore.consume")(
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
                error: invalidBootstrapCredentialError("Unknown bootstrap credential."),
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
                error: invalidBootstrapCredentialError("Bootstrap credential expired."),
              },
              next,
            ];
          }

          if (grant.proofKeyThumbprint && grant.proofKeyThumbprint !== input?.proofKeyThumbprint) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: invalidBootstrapCredentialError("Bootstrap credential proof key mismatch."),
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
        return yield* invalidBootstrapCredentialError("Unknown bootstrap credential.");
      }

      if (matching.value.revokedAt !== null) {
        return yield* invalidBootstrapCredentialError(
          "Bootstrap credential is no longer available.",
        );
      }

      if (matching.value.consumedAt !== null) {
        return yield* invalidBootstrapCredentialError("Unknown bootstrap credential.");
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* invalidBootstrapCredentialError("Bootstrap credential expired.");
      }

      if (
        matching.value.proofKeyThumbprint !== null &&
        matching.value.proofKeyThumbprint !== input?.proofKeyThumbprint
      ) {
        return yield* invalidBootstrapCredentialError("Bootstrap credential proof key mismatch.");
      }

      return yield* invalidBootstrapCredentialError("Bootstrap credential is no longer available.");
    },
    Effect.mapError((cause) =>
      cause._tag === "BootstrapCredentialInvalidError" ||
      cause._tag === "BootstrapCredentialInternalError"
        ? cause
        : internalBootstrapCredentialError("Failed to consume bootstrap credential.", cause),
    ),
  );

  return {
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
  } satisfies PairingGrantStoreShape;
});

export const layer = Layer.effect(PairingGrantStore, make()).pipe(
  Layer.provideMerge(AuthPairingLinkRepositoryLive),
);
