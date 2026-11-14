import {
  AuthStandardClientScopes,
  type AuthClientMetadata,
  type AuthConnectDevice,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthPairingLink,
  mcpApprovalCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  parseMcpApprovalCode,
  type ServerAuthBootstrapMethod,
  connectDeviceVerificationCode,
} from "@t3tools/contracts";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  isValidDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as AuthConnectDevices from "../persistence/AuthConnectDevices.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt: DateTime.DateTime;
}

export class UnknownBootstrapCredentialError extends Schema.TaggedError<UnknownBootstrapCredentialError>()(
  "UnknownBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Unknown bootstrap credential.";
  }
}

export class ExpiredBootstrapCredentialError extends Schema.TaggedError<ExpiredBootstrapCredentialError>()(
  "ExpiredBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential expired.";
  }
}

export class BootstrapCredentialProofKeyMismatchError extends Schema.TaggedError<BootstrapCredentialProofKeyMismatchError>()(
  "BootstrapCredentialProofKeyMismatchError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential proof key mismatch.";
  }
}

export class UnavailableBootstrapCredentialError extends Schema.TaggedError<UnavailableBootstrapCredentialError>()(
  "UnavailableBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential is no longer available.";
  }
}

export class BootstrapCredentialScopeNotGrantedError extends Schema.TaggedError<BootstrapCredentialScopeNotGrantedError>()(
  "BootstrapCredentialScopeNotGrantedError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope was not granted.";
  }
}

/** The credential is valid but its T3 Connect device key still waits for approval. */
export class BootstrapCredentialConnectApprovalPendingError extends Schema.TaggedError<BootstrapCredentialConnectApprovalPendingError>()(
  "BootstrapCredentialConnectApprovalPendingError",
  {
    pairingLinkId: Schema.String,
  },
) {
  override get message(): string {
    return "This T3 Connect device is waiting for approval.";
  }
}

export const BootstrapCredentialInvalidError = Schema.Union([
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
  BootstrapCredentialProofKeyMismatchError,
  UnavailableBootstrapCredentialError,
  BootstrapCredentialConnectApprovalPendingError,
]);
export type BootstrapCredentialInvalidError = typeof BootstrapCredentialInvalidError.Type;

export class ActivePairingLinksLoadError extends Schema.TaggedError<ActivePairingLinksLoadError>()(
  "ActivePairingLinksLoadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load active pairing links.";
  }
}

export class PairingLinkRevokeError extends Schema.TaggedError<PairingLinkRevokeError>()(
  "PairingLinkRevokeError",
  {
    pairingLinkId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke pairing link '${this.pairingLinkId}'.`;
  }
}

export class PairingCredentialIssueError extends Schema.TaggedError<PairingCredentialIssueError>()(
  "PairingCredentialIssueError",
  {
    pairingLinkId: Schema.String,
    subject: Schema.String,
    label: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to issue pairing credential '${this.pairingLinkId}' for '${this.subject}'.`;
  }
}

export class PairingCredentialRandomGenerationError extends Schema.TaggedError<PairingCredentialRandomGenerationError>()(
  "PairingCredentialRandomGenerationError",
  {
    operation: Schema.Literals(["generate-id", "generate-token"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate pairing credential data during '${this.operation}'.`;
  }
}

export class BootstrapCredentialConsumeError extends Schema.TaggedError<BootstrapCredentialConsumeError>()(
  "BootstrapCredentialConsumeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to consume bootstrap credential.";
  }
}

export class BootstrapCredentialConsumeAvailableError extends Schema.TaggedError<BootstrapCredentialConsumeAvailableError>()(
  "BootstrapCredentialConsumeAvailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to atomically consume an available bootstrap credential.";
  }
}

export class ConnectDevicesError extends Schema.TaggedError<ConnectDevicesError>()(
  "ConnectDevicesError",
  {
    operation: Schema.Literals(["list", "trust", "revoke", "record-request"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} T3 Connect devices.`;
  }
}

export class BootstrapCredentialLookupError extends Schema.TaggedError<BootstrapCredentialLookupError>()(
  "BootstrapCredentialLookupError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to look up bootstrap credential state.";
  }
}

export const BootstrapCredentialInternalError = Schema.Union([
  ActivePairingLinksLoadError,
  PairingLinkRevokeError,
  PairingCredentialIssueError,
  PairingCredentialRandomGenerationError,
  BootstrapCredentialConsumeError,
  BootstrapCredentialConsumeAvailableError,
  BootstrapCredentialLookupError,
  ConnectDevicesError,
]);
export type BootstrapCredentialInternalError = typeof BootstrapCredentialInternalError.Type;
export const isBootstrapCredentialInternalError = Schema.is(BootstrapCredentialInternalError);

export const BootstrapCredentialError = Schema.Union([
  BootstrapCredentialInvalidError,
  BootstrapCredentialInternalError,
  BootstrapCredentialScopeNotGrantedError,
]);
export type BootstrapCredentialError = typeof BootstrapCredentialError.Type;

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
    }
  | {
      readonly type: "connectDevicesChanged";
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
      readonly purpose?: "startup";
      /** Issues a hidden `<LEVEL>-` code that only an agent sign-in at this level can spend. */
      readonly mcpApproval?: AuthMcpClientAccess;
      /** Spendable only after someone trusts `proofKeyThumbprint` as a T3 Connect device. */
      readonly requiresConnectApproval?: boolean;
    }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialInternalError>;
    /** A device's open or denied request, reused so retries keep one request and one code. */
    readonly findPendingConnect: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<Option.Option<IssuedBootstrapCredential>, BootstrapCredentialInternalError>;
    /** Shows approvers what a waiting device says it is. Only its first description sticks. */
    readonly recordConnectRequestClient: (
      pairingLinkId: string,
      client: AuthClientMetadata,
    ) => Effect.Effect<void, BootstrapCredentialInternalError>;
    /** Trusts the device key behind a waiting request. False when it is gone or not a request. */
    readonly approveConnectRequest: (
      pairingLinkId: string,
    ) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly isConnectDeviceTrusted: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly trustConnectDevice: (
      proofKeyThumbprint: string,
      client: AuthClientMetadata,
    ) => Effect.Effect<void, BootstrapCredentialInternalError>;
    readonly listConnectDevices: () => Effect.Effect<
      ReadonlyArray<AuthConnectDevice>,
      BootstrapCredentialInternalError
    >;
    readonly revokeConnectDevice: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly revokeConnectDevicesExcept: (
      keepProofKeyThumbprint: string | null,
    ) => Effect.Effect<number, BootstrapCredentialInternalError>;
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
        readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
        /** All scopes must be granted; requestedScopes only requires an overlap for OAuth. */
        readonly requiredScopes?: ReadonlyArray<AuthEnvironmentScope>;
        /** Also spends a code issued for an agent sign-in at this level; others refuse them. */
        readonly mcpApproval?: AuthMcpClientAccess;
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
      readonly reason: "not-found" | "expired" | "scope-not-granted";
      readonly error: BootstrapCredentialError;
    }
  | {
      readonly _tag: "success";
      readonly grant: BootstrapGrant;
    };

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);

const toPairingLink = (row: AuthPairingLinks.AuthPairingLinkRecord): AuthPairingLink => ({
  id: row.id,
  scopes: row.scopes,
  subject: row.subject,
  ...(row.label ? { label: row.label } : {}),
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  ...(row.requiresConnectApproval === 1 && row.proofKeyThumbprint
    ? {
        connectDeviceRequest: {
          verificationCode: connectDeviceVerificationCode(row.proofKeyThumbprint),
          ...(row.requestedClient ? { client: row.requestedClient } : {}),
        },
      }
    : {}),
});
const DESKTOP_BOOTSTRAP_TTL_HOURS = Duration.hours(24);
const DEV_STARTUP_TTL_HOURS = Duration.hours(24);
const PAIRING_TOKEN_REJECTION_LIMIT =
  Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;

const PAIRING_TOKEN_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`,
  "i",
);

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const connectDevices = yield* AuthConnectDevices.AuthConnectDeviceRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();
  const generatePairingToken = Effect.gen(function* () {
    let credential = "";
    while (credential.length < PAIRING_CODE_LENGTH) {
      const bytes = yield* random
        .randomBytes(PAIRING_CODE_LENGTH)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PairingCredentialRandomGenerationError({ operation: "generate-token", cause }),
          ),
        );
      for (const byte of bytes) {
        if (byte >= PAIRING_TOKEN_REJECTION_LIMIT) {
          continue;
        }
        credential += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]!;
        if (credential.length === PAIRING_CODE_LENGTH) {
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

  // Accept tokens derived from the rotating desktop secret; older desktops send only a token.
  const desktopBootstrapSecret = config.desktopBootstrapSecret;
  const mac = yield* Mac.Mac;
  const consumeRotatingDesktopToken = (credential: string, nowMs: number) =>
    desktopBootstrapSecret === undefined
      ? Effect.succeed(false)
      : isValidDesktopBootstrapToken(desktopBootstrapSecret, credential, nowMs).pipe(
          Effect.provideService(Mac.Mac, mac),
        );

  if (config.desktopBootstrapToken && desktopBootstrapSecret === undefined) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      scopes: AuthStandardClientScopes,
      subject: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DESKTOP_BOOTSTRAP_TTL_HOURS),
      }),
      // Reloads and expired bearer sessions must be able to re-exchange the desktop seed.
      remainingUses: "unbounded",
    });
  }

  const listActive: PairingGrantStore["Service"]["listActive"] = Effect.fn(
    "PairingGrantStore.listActive",
  )(
    function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });
      // An approved request only waits for its device to come back and spend it.
      return rows
        .filter((row) => !(row.requiresConnectApproval === 1 && row.connectApproved === 1))
        .map(toPairingLink);
    },
    Effect.mapError((cause) => new ActivePairingLinksLoadError({ cause })),
  );

  const revoke: PairingGrantStore["Service"]["revoke"] = Effect.fn("PairingGrantStore.revoke")(
    function* (id) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks
        .revoke({
          id,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new PairingLinkRevokeError({ pairingLinkId: id, cause })));
      if (revoked) {
        yield* emitRemoved(id);
      }
      return revoked;
    },
  );

  const issueOneTimeToken: PairingGrantStore["Service"]["issueOneTimeToken"] = Effect.fn(
    "PairingGrantStore.issueOneTimeToken",
  )(function* (input) {
    const id = yield* random
      .uuidV4()
      .pipe(
        Effect.mapError(
          (cause) =>
            new PairingCredentialRandomGenerationError({ operation: "generate-id", cause }),
        ),
      );
    const token = yield* generatePairingToken;
    const mcpApproval = input?.mcpApproval;
    const credential = mcpApproval ? mcpApprovalCode(mcpApproval, token) : token;
    const isDevStartupToken = config.devUrl !== undefined && input?.purpose === "startup";
    const ttl =
      input?.ttl ??
      (isDevStartupToken ? DEV_STARTUP_TTL_HOURS : DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES);
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(ttl) });
    const issued: IssuedBootstrapCredential = {
      id,
      credential,
      ...(input?.label ? { label: input.label } : {}),
      ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
      expiresAt,
    };
    const subject = mcpApproval
      ? `${AuthPairingLinks.MCP_APPROVAL_SUBJECT_PREFIX}${mcpApproval}`
      : (input?.subject ?? "one-time-token");
    yield* pairingLinks
      .create({
        id,
        credential,
        method: "one-time-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject,
        label: input?.label ?? null,
        proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
        ...(input?.requiresConnectApproval ? { requiresConnectApproval: true } : {}),
        createdAt: now,
        expiresAt: expiresAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PairingCredentialIssueError({
              pairingLinkId: id,
              subject,
              ...(input?.label ? { label: input.label } : {}),
              cause,
            }),
        ),
      );
    // Approval codes stay out of the pairing links and QR codes that clients show.
    if (!mcpApproval) {
      yield* emitUpsert({
        id,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject,
        ...(input?.label ? { label: input.label } : {}),
        createdAt: now,
        expiresAt,
        ...(input?.requiresConnectApproval && input.proofKeyThumbprint
          ? {
              connectDeviceRequest: {
                verificationCode: connectDeviceVerificationCode(input.proofKeyThumbprint),
              },
            }
          : {}),
      });
    }
    return issued;
  });

  const consume: PairingGrantStore["Service"]["consume"] = Effect.fn("PairingGrantStore.consume")(
    function* (credential, input) {
      const now = yield* DateTime.now;
      if (yield* consumeRotatingDesktopToken(credential, now.epochMilliseconds)) {
        return {
          method: "desktop-bootstrap",
          scopes: AuthStandardClientScopes,
          subject: "desktop-bootstrap",
          expiresAt: DateTime.add(now, {
            milliseconds: DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
          }),
        } satisfies BootstrapGrant;
      }
      const seededResult: ConsumeResult = yield* Ref.modify(
        seededGrantsRef,
        (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
          const grant = current.get(credential);
          if (!grant) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: new UnknownBootstrapCredentialError({}),
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
                error: new ExpiredBootstrapCredentialError({}),
              },
              next,
            ];
          }

          if (grant.proofKeyThumbprint && grant.proofKeyThumbprint !== input?.proofKeyThumbprint) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: new BootstrapCredentialProofKeyMismatchError({}),
              },
              next,
            ];
          }

          if (
            (input?.requestedScopes !== undefined &&
              !input.requestedScopes.some((scope) => grant.scopes.includes(scope))) ||
            (input?.requiredScopes !== undefined &&
              !input.requiredScopes.every((scope) => grant.scopes.includes(scope)))
          ) {
            return [
              {
                _tag: "error",
                reason: "scope-not-granted",
                error: new BootstrapCredentialScopeNotGrantedError({}),
              },
              current,
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

      // Only credentials in the issued pairing-code formats are case-insensitive.
      const pairingCredential = PAIRING_TOKEN_PATTERN.test(credential)
        ? credential.toUpperCase()
        : (parseMcpApprovalCode(credential)?.code ?? credential);

      // Check scopes in the UPDATE so rejected requests cannot spend one-time links.
      const consumed = yield* pairingLinks
        .consumeAvailable({
          credential: pairingCredential,
          proofKeyThumbprint: input?.proofKeyThumbprint ?? null,
          ...(input?.requestedScopes !== undefined
            ? { requestedScopes: input.requestedScopes }
            : {}),
          ...(input?.requiredScopes !== undefined ? { requiredScopes: input.requiredScopes } : {}),
          ...(input?.mcpApproval
            ? {
                mcpApprovalSubject: `${AuthPairingLinks.MCP_APPROVAL_SUBJECT_PREFIX}${input.mcpApproval}`,
              }
            : {}),
          consumedAt: now,
          now,
        })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialConsumeAvailableError({ cause })));

      if (Option.isSome(consumed)) {
        if (!consumed.value.subject.startsWith(AuthPairingLinks.MCP_APPROVAL_SUBJECT_PREFIX)) {
          yield* emitRemoved(consumed.value.id);
        }
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

      const matching = yield* pairingLinks
        .getByCredential({ credential: pairingCredential })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
      if (Option.isNone(matching)) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (matching.value.revokedAt !== null) {
        return yield* new UnavailableBootstrapCredentialError({});
      }

      if (matching.value.consumedAt !== null) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* new ExpiredBootstrapCredentialError({});
      }

      if (
        matching.value.proofKeyThumbprint !== null &&
        matching.value.proofKeyThumbprint !== input?.proofKeyThumbprint
      ) {
        return yield* new BootstrapCredentialProofKeyMismatchError({});
      }

      if (
        (input?.requestedScopes !== undefined &&
          !input.requestedScopes.some((scope) => matching.value.scopes.includes(scope))) ||
        (input?.requiredScopes !== undefined &&
          !input.requiredScopes.every((scope) => matching.value.scopes.includes(scope)))
      ) {
        return yield* new BootstrapCredentialScopeNotGrantedError({});
      }

      if (matching.value.requiresConnectApproval === 1 && matching.value.connectApproved === 0) {
        return yield* new BootstrapCredentialConnectApprovalPendingError({
          pairingLinkId: matching.value.id,
        });
      }

      return yield* new UnavailableBootstrapCredentialError({});
    },
  );

  const emitConnectDevicesChanged = PubSub.publish(changesPubSub, {
    type: "connectDevicesChanged",
  }).pipe(Effect.asVoid);

  const findPendingConnect: PairingGrantStore["Service"]["findPendingConnect"] = Effect.fn(
    "PairingGrantStore.findPendingConnect",
  )(
    function* (proofKeyThumbprint) {
      const now = yield* DateTime.now;
      const row = yield* pairingLinks.findPendingConnect({ proofKeyThumbprint, now });
      return Option.map(row, (link): IssuedBootstrapCredential => ({
        id: link.id,
        credential: link.credential,
        ...(link.label ? { label: link.label } : {}),
        proofKeyThumbprint,
        expiresAt: link.expiresAt,
      }));
    },
    Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })),
  );

  const recordConnectRequestClient: PairingGrantStore["Service"]["recordConnectRequestClient"] =
    Effect.fn("PairingGrantStore.recordConnectRequestClient")(function* (pairingLinkId, client) {
      const recorded = yield* pairingLinks
        .recordConnectRequestClient({ id: pairingLinkId, client })
        .pipe(
          Effect.mapError(
            (cause) => new ConnectDevicesError({ operation: "record-request", cause }),
          ),
        );
      if (!recorded) return;
      const now = yield* DateTime.now;
      const row = yield* pairingLinks
        .getActiveById({ id: pairingLinkId, now })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
      if (Option.isSome(row)) yield* emitUpsert(toPairingLink(row.value));
    });

  const trustConnectDevice: PairingGrantStore["Service"]["trustConnectDevice"] = Effect.fn(
    "PairingGrantStore.trustConnectDevice",
  )(function* (proofKeyThumbprint, client) {
    const approvedAt = yield* DateTime.now;
    yield* connectDevices
      .trust({ proofKeyThumbprint, client, approvedAt })
      .pipe(Effect.mapError((cause) => new ConnectDevicesError({ operation: "trust", cause })));
    yield* emitConnectDevicesChanged;
  });

  const approveConnectRequest: PairingGrantStore["Service"]["approveConnectRequest"] = Effect.fn(
    "PairingGrantStore.approveConnectRequest",
  )(function* (pairingLinkId) {
    const now = yield* DateTime.now;
    const row = yield* pairingLinks
      .getActiveById({ id: pairingLinkId, now })
      .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
    if (
      Option.isNone(row) ||
      row.value.requiresConnectApproval !== 1 ||
      row.value.proofKeyThumbprint === null
    ) {
      return false;
    }
    yield* connectDevices
      .trust({
        proofKeyThumbprint: row.value.proofKeyThumbprint,
        client: row.value.requestedClient,
        approvedAt: now,
      })
      .pipe(Effect.mapError((cause) => new ConnectDevicesError({ operation: "trust", cause })));
    yield* emitRemoved(pairingLinkId);
    yield* emitConnectDevicesChanged;
    return true;
  });

  const isConnectDeviceTrusted: PairingGrantStore["Service"]["isConnectDeviceTrusted"] = (
    proofKeyThumbprint,
  ) =>
    connectDevices
      .isTrusted(proofKeyThumbprint)
      .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));

  const listConnectDevices: PairingGrantStore["Service"]["listConnectDevices"] = () =>
    connectDevices.list().pipe(
      Effect.map((rows) =>
        rows.map((row): AuthConnectDevice => ({
          proofKeyThumbprint: row.proofKeyThumbprint,
          verificationCode: connectDeviceVerificationCode(row.proofKeyThumbprint),
          ...(row.client ? { client: row.client } : {}),
          approvedAt: row.approvedAt,
        })),
      ),
      Effect.mapError((cause) => new ConnectDevicesError({ operation: "list", cause })),
    );

  // A credential minted before revocation is still spendable; it must die with the trust,
  // or exchanging it would trust the key again without approval.
  const revokeUnspentLinks = Effect.fn("PairingGrantStore.revokeUnspentLinks")(function* (
    input: Omit<AuthPairingLinks.RevokeUnspentByProofKeyInput, "revokedAt">,
  ) {
    const revokedAt = yield* DateTime.now;
    const ids = yield* pairingLinks
      .revokeUnspentByProofKey({ ...input, revokedAt })
      .pipe(Effect.mapError((cause) => new ConnectDevicesError({ operation: "revoke", cause })));
    yield* Effect.forEach(ids, emitRemoved, { discard: true });
  });

  const revokeConnectDevice: PairingGrantStore["Service"]["revokeConnectDevice"] = Effect.fn(
    "PairingGrantStore.revokeConnectDevice",
  )(function* (proofKeyThumbprint) {
    yield* revokeUnspentLinks({ proofKeyThumbprint, keepProofKeyThumbprint: null });
    const removed = yield* connectDevices
      .remove(proofKeyThumbprint)
      .pipe(Effect.mapError((cause) => new ConnectDevicesError({ operation: "revoke", cause })));
    if (removed) yield* emitConnectDevicesChanged;
    return removed;
  });

  const revokeConnectDevicesExcept: PairingGrantStore["Service"]["revokeConnectDevicesExcept"] =
    Effect.fn("PairingGrantStore.revokeConnectDevicesExcept")(function* (keepProofKeyThumbprint) {
      yield* revokeUnspentLinks({ proofKeyThumbprint: null, keepProofKeyThumbprint });
      const removed = yield* connectDevices
        .removeAllExcept(keepProofKeyThumbprint)
        .pipe(Effect.mapError((cause) => new ConnectDevicesError({ operation: "revoke", cause })));
      if (removed > 0) yield* emitConnectDevicesChanged;
      return removed;
    });

  return PairingGrantStore.of({
    issueOneTimeToken,
    findPendingConnect,
    recordConnectRequestClient,
    approveConnectRequest,
    isConnectDeviceTrusted,
    trustConnectDevice,
    listConnectDevices,
    revokeConnectDevice,
    revokeConnectDevicesExcept,
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
  Layer.provideMerge(AuthConnectDevices.layer),
);
