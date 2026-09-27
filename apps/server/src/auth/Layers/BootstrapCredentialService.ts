import { AuthBrowserPreviewScope, type AuthPairingLink } from "@t3tools/contracts";
import { DateTime, Duration, Effect, Layer, PubSub, Ref, Stream } from "effect";
import { Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { AuthPairingLinkRepositoryLive } from "../../persistence/Layers/AuthPairingLinks.ts";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks.ts";
import {
  BootstrapCredentialError,
  BootstrapCredentialService,
  type BootstrapCredentialChange,
  type BootstrapCredentialServiceShape,
  type BootstrapGrant,
  type IssuedBootstrapCredential,
} from "../Services/BootstrapCredentialService.ts";
import { defaultSessionScopes } from "../scopes.ts";

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly id?: string;
  readonly transient?: boolean;
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

const generatePairingToken = (): string => {
  const randomBytes = crypto.getRandomValues(new Uint8Array(PAIRING_TOKEN_LENGTH));

  return Array.from(randomBytes, (value) => PAIRING_TOKEN_ALPHABET[value & 31]).join("");
};

const generateTransientBootstrapCredential = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");

export const makeBootstrapCredentialService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const pairingLinks = yield* AuthPairingLinkRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const revokedTransientSubjectsRef = yield* Ref.make(new Set<string>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();

  const invalidBootstrapCredentialError = (message: string) =>
    new BootstrapCredentialError({
      message,
      status: 401,
    });

  const internalBootstrapCredentialError = (message: string, cause: unknown) =>
    new BootstrapCredentialError({
      message,
      status: 500,
      cause,
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
      role: "owner",
      scopes: defaultSessionScopes("owner"),
      subject: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES),
      }),
      remainingUses: 1,
    });
  }

  const toBootstrapCredentialError = (message: string) => (cause: unknown) =>
    cause instanceof BootstrapCredentialError
      ? cause
      : internalBootstrapCredentialError(message, cause);

  const listActive: BootstrapCredentialServiceShape["listActive"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });

      return rows.map((row) =>
        row.label
          ? ({
              id: row.id,
              credential: row.credential,
              role: row.role,
              scopes: row.scopes ?? defaultSessionScopes(row.role),
              subject: row.subject,
              label: row.label,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink)
          : ({
              id: row.id,
              credential: row.credential,
              role: row.role,
              scopes: row.scopes ?? defaultSessionScopes(row.role),
              subject: row.subject,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink),
      );
    }).pipe(Effect.mapError(toBootstrapCredentialError("Failed to load active pairing links.")));

  const revoke: BootstrapCredentialServiceShape["revoke"] = (id) =>
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks.revoke({
        id,
        revokedAt,
      });
      if (revoked) {
        yield* emitRemoved(id);
      }
      return revoked;
    }).pipe(Effect.mapError(toBootstrapCredentialError("Failed to revoke pairing link.")));

  const issueOneTimeToken: BootstrapCredentialServiceShape["issueOneTimeToken"] = (input) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const credential = generatePairingToken();
      const ttl = input?.ttl ?? DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES;
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(ttl) });
      const issued: IssuedBootstrapCredential = {
        id,
        credential,
        scopes: input?.scopes ?? defaultSessionScopes(input?.role ?? "client"),
        ...(input?.label ? { label: input.label } : {}),
        expiresAt,
      };
      yield* pairingLinks.create({
        id,
        credential,
        method: "one-time-token",
        role: input?.role ?? "client",
        scopes: issued.scopes,
        subject: input?.subject ?? "one-time-token",
        label: input?.label ?? null,
        proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
        createdAt: now,
        expiresAt: expiresAt,
      });
      yield* emitUpsert({
        id,
        credential,
        role: input?.role ?? "client",
        scopes: issued.scopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
        createdAt: now,
        expiresAt,
      });
      return issued;
    }).pipe(Effect.mapError(toBootstrapCredentialError("Failed to issue pairing credential.")));

  const issueTransientBrowserSessionToken: BootstrapCredentialServiceShape["issueTransientBrowserSessionToken"] =
    (input) =>
      Effect.gen(function* () {
        const revokedSubjects = yield* Ref.get(revokedTransientSubjectsRef);
        if (revokedSubjects.has(input.subject)) {
          return yield* new BootstrapCredentialError({
            message: "Preview authorization is no longer active.",
            status: 401,
          });
        }
        const id = crypto.randomUUID();
        const credential = generateTransientBootstrapCredential();
        const scopes = [AuthBrowserPreviewScope] as const;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, {
          milliseconds: Duration.toMillis(input.ttl),
        });
        const issued: IssuedBootstrapCredential = {
          id,
          credential,
          scopes,
          ...(input.label ? { label: input.label } : {}),
          expiresAt,
        };
        yield* Ref.update(seededGrantsRef, (current) => {
          const next = new Map(
            Array.from(current).filter(
              ([, grant]) =>
                !grant.transient || !DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt),
            ),
          );
          next.set(credential, {
            id,
            transient: true,
            method: "one-time-token",
            role: "client",
            scopes,
            subject: input.subject,
            ...(input.label ? { label: input.label } : {}),
            browserSessionOnly: true,
            expiresAt,
            remainingUses: 1,
          });
          return next;
        });
        if ((yield* Ref.get(revokedTransientSubjectsRef)).has(input.subject)) {
          yield* revokeTransientOneTimeToken(id);
          return yield* new BootstrapCredentialError({
            message: "Preview authorization is no longer active.",
            status: 401,
          });
        }
        return issued;
      }).pipe(Effect.mapError(toBootstrapCredentialError("Failed to issue transient credential.")));

  const revokeTransientOneTimeToken: BootstrapCredentialServiceShape["revokeTransientOneTimeToken"] =
    (id) =>
      Ref.modify(seededGrantsRef, (current) => {
        const match = Array.from(current).find(
          ([, grant]) => grant.transient === true && grant.id === id,
        );
        if (!match) return [false, current] as const;
        const next = new Map(current);
        next.delete(match[0]);
        return [true, next] as const;
      });

  const revokeTransientOneTimeTokensForSubject: BootstrapCredentialServiceShape["revokeTransientOneTimeTokensForSubject"] =
    (subject) =>
      Ref.update(revokedTransientSubjectsRef, (current) => new Set(current).add(subject)).pipe(
        Effect.andThen(
          Ref.modify(seededGrantsRef, (current) => {
            let revokedCount = 0;
            const next = new Map<string, StoredBootstrapGrant>();
            for (const [credential, grant] of current) {
              if (grant.transient === true && grant.subject === subject) {
                revokedCount += 1;
              } else {
                next.set(credential, grant);
              }
            }
            return [revokedCount, revokedCount === 0 ? current : next] as const;
          }),
        ),
      );

  const isTransientSubjectRevoked: BootstrapCredentialServiceShape["isTransientSubjectRevoked"] = (
    subject,
  ) => Ref.get(revokedTransientSubjectsRef).pipe(Effect.map((subjects) => subjects.has(subject)));

  const consume: BootstrapCredentialServiceShape["consume"] = (credential, proofKeyThumbprint) =>
    Effect.gen(function* () {
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
          if (grant.proofKeyThumbprint !== proofKeyThumbprint) {
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
                role: grant.role,
                scopes: grant.scopes,
                subject: grant.subject,
                ...(grant.label ? { label: grant.label } : {}),
                ...(grant.proofKeyThumbprint
                  ? { proofKeyThumbprint: grant.proofKeyThumbprint }
                  : {}),
                ...(grant.browserSessionOnly ? { browserSessionOnly: true } : {}),
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
        proofKeyThumbprint: proofKeyThumbprint ?? null,
        consumedAt: now,
        now,
      });

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return {
          method: consumed.value.method,
          role: consumed.value.role,
          scopes: consumed.value.scopes ?? defaultSessionScopes(consumed.value.role),
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
      if ((matching.value.proofKeyThumbprint ?? undefined) !== proofKeyThumbprint) {
        return yield* invalidBootstrapCredentialError(
          "Bootstrap credential proof key does not match.",
        );
      }

      if (matching.value.consumedAt !== null) {
        return yield* invalidBootstrapCredentialError("Unknown bootstrap credential.");
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* invalidBootstrapCredentialError("Bootstrap credential expired.");
      }

      return yield* invalidBootstrapCredentialError("Bootstrap credential is no longer available.");
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof BootstrapCredentialError
          ? cause
          : internalBootstrapCredentialError("Failed to consume bootstrap credential.", cause),
      ),
    );

  return {
    issueOneTimeToken,
    issueTransientBrowserSessionToken,
    revokeTransientOneTimeToken,
    revokeTransientOneTimeTokensForSubject,
    isTransientSubjectRevoked,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
  } satisfies BootstrapCredentialServiceShape;
});

export const BootstrapCredentialServiceLive = Layer.effect(
  BootstrapCredentialService,
  makeBootstrapCredentialService,
).pipe(Layer.provideMerge(AuthPairingLinkRepositoryLive));
