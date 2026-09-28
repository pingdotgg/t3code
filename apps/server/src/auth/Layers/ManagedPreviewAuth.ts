import {
  AuthBrowserPreviewScope,
  type EnvironmentId,
  type PreviewAutomationManagedTargetAuth,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { createHash, generateKeyPairSync, sign as signMessage, timingSafeEqual } from "node:crypto";
import {
  createPreviewBootstrapKeyPair,
  openPreviewBootstrapPayload,
  sealPreviewBootstrapPayload,
  type PreviewBootstrapCryptoContext,
} from "@t3tools/shared/previewBootstrapCrypto";
import { DateTime, Duration, Effect, Layer, Ref } from "effect";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import type { ServerConfigShape } from "../../config.ts";
import { isLoopbackHost, formatHostForUrl } from "../../startupAccess.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ManagedPreviewAuth,
  ManagedPreviewAuthError,
  type ManagedPreviewAuthGrant,
} from "../Services/ManagedPreviewAuth.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";

const PREVIEW_SESSION_SUBJECT_PREFIX = "t3-browser-preview:";
const PREVIEW_BOOTSTRAP_TTL = Duration.seconds(60);
const PREVIEW_ATTESTATION_TTL = Duration.seconds(60);
const PREVIEW_SESSION_LABEL = "T3 browser preview";

interface Attestation {
  readonly providerSessionId: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly credentialHashes: ReadonlyMap<string, string>;
  readonly expiresAt: DateTime.DateTime;
}

interface ManagedOrigins {
  readonly targetOrigins: ReadonlyArray<string>;
}

interface ResolvedTarget {
  readonly expectedOrigins: ReadonlyArray<string>;
  readonly matches: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const originForHost = (protocol: string, host: string, port: number): string => {
  return new URL(`${protocol}//${formatHostForUrl(host)}:${port}`).origin;
};

const urlPort = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80));

const parseHttpUrl = (raw: string): URL | undefined => {
  try {
    const parsed = new URL(normalizePreviewUrl(raw));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const readOperationTarget = (
  operation: PreviewAutomationOperation,
  input: unknown,
):
  | { readonly _tag: "url"; readonly url: string }
  | {
      readonly _tag: "environment-port";
      readonly port: number;
      readonly protocol: "http" | "https";
    }
  | undefined => {
  if (operation !== "open" && operation !== "navigate" && operation !== "openAndSnapshot") {
    return undefined;
  }

  const url = readString(input, "url");
  if (url !== undefined) return { _tag: "url", url };

  const target = isRecord(input) ? input.target : undefined;
  if (!isRecord(target)) return undefined;
  if (target.kind === "url" && typeof target.url === "string") {
    return { _tag: "url", url: target.url };
  }
  if (
    target.kind === "environment-port" &&
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    (target.protocol === undefined || target.protocol === "http" || target.protocol === "https")
  ) {
    return {
      _tag: "environment-port",
      port: target.port,
      protocol: target.protocol ?? "http",
    };
  }
  return undefined;
};

const makeManagedOrigins = (
  config: ServerConfigShape,
  address: HttpServer.Address,
): ManagedOrigins | undefined => {
  if (address._tag !== "TcpAddress") return undefined;
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const host of [config.host, address.hostname]) {
    if (host && isLoopbackHost(host)) hosts.add(stripIpv6Brackets(host));
  }
  const apiOrigins = Array.from(hosts, (host) => originForHost("http:", host, address.port));
  const configuredDevUrl = config.devUrl;
  if (!configuredDevUrl) {
    return {
      targetOrigins: apiOrigins,
    };
  }

  if (
    (configuredDevUrl.protocol !== "http:" && configuredDevUrl.protocol !== "https:") ||
    !isLoopbackHost(configuredDevUrl.hostname)
  ) {
    return {
      targetOrigins: apiOrigins,
    };
  }

  const devOrigin = configuredDevUrl.origin;
  const port = urlPort(configuredDevUrl);
  const devAliases = Array.from(hosts, (host) =>
    originForHost(configuredDevUrl.protocol, host, port),
  );
  const targetOrigins = Array.from(new Set([devOrigin, ...apiOrigins, ...devAliases]));

  return { targetOrigins };
};

const resolveManagedTarget = (
  operation: PreviewAutomationOperation,
  input: unknown,
  origins: ManagedOrigins,
): ResolvedTarget | undefined => {
  const requested = readOperationTarget(operation, input);
  if (!requested) return undefined;

  if (requested._tag === "environment-port") {
    const expectedOrigins = origins.targetOrigins.filter((origin) => {
      const parsed = new URL(origin);
      return urlPort(parsed) === requested.port && parsed.protocol === `${requested.protocol}:`;
    });
    return expectedOrigins.length > 0 ? { expectedOrigins, matches: true } : undefined;
  }

  const url = parseHttpUrl(requested.url);
  if (!url) return undefined;
  if (origins.targetOrigins.includes(url.origin)) {
    return { expectedOrigins: [url.origin], matches: true };
  }

  if (!isLoopbackHost(url.hostname)) return undefined;
  const expectedOrigins = origins.targetOrigins.filter((origin) => {
    const expected = new URL(origin);
    return expected.protocol === url.protocol && urlPort(expected) === urlPort(url);
  });
  return expectedOrigins.length > 0 ? { expectedOrigins, matches: false } : undefined;
};

const makePreviewSubject = (providerSessionId: string): string =>
  `${PREVIEW_SESSION_SUBJECT_PREFIX}${providerSessionId}`;

const attestationMessage = (
  environmentId: EnvironmentId,
  origin: string,
  challenge: string,
  bootstrapEncryptionPublicKey: string,
): Buffer =>
  Buffer.from(
    `${environmentId}\u0000${origin}\u0000${challenge}\u0000${bootstrapEncryptionPublicKey}`,
  );

const hashCredential = (credential: string): string =>
  createHash("sha256").update(credential, "utf8").digest("base64url");

const toManagedPreviewAuthError =
  (message: string, reason: ManagedPreviewAuthError["reason"] = "bootstrap-failed") =>
  (cause: unknown): ManagedPreviewAuthError =>
    new ManagedPreviewAuthError({ message, reason, cause });

export const makeManagedPreviewAuth = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const policy = yield* ServerAuthPolicy;
  const descriptor = yield* policy.getDescriptor();
  const serverEnvironment = yield* ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const sessions = yield* SessionCredentialService;
  const keyPair = yield* Effect.try({
    try: () => generateKeyPairSync("ed25519"),
    catch: (cause) =>
      new ManagedPreviewAuthError({
        message: "Failed to create managed preview attestation keys.",
        cause,
      }),
  });
  const bootstrapKeyPair = yield* Effect.try({
    try: () => createPreviewBootstrapKeyPair(),
    catch: (cause) =>
      new ManagedPreviewAuthError({
        message: "Failed to create managed preview exchange keys.",
        cause,
      }),
  });
  const attestationPublicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const bootstrapEncryptionPublicKey = bootstrapKeyPair.publicKey;
  const attestationsRef = yield* Ref.make(new Map<string, Attestation>());
  const origins = makeManagedOrigins(config, httpServer.address);
  const automaticAuthAllowed =
    descriptor.policy === "desktop-managed-local" || descriptor.policy === "loopback-browser";

  const revokeSessionsForSubject = (subject: string) =>
    Effect.gen(function* () {
      const activeSessions = yield* sessions.listActive();
      yield* Effect.forEach(
        activeSessions.filter(
          (session) =>
            session.subject === subject &&
            session.scopes?.includes(AuthBrowserPreviewScope) === true,
        ),
        (session) => sessions.revoke(session.sessionId),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      Effect.mapError(toManagedPreviewAuthError("Failed to revoke managed preview sessions.")),
    );

  const revokeAll: ManagedPreviewAuth["Service"]["revokeAll"] = Effect.gen(function* () {
    const activeSessions = yield* sessions.listActive();
    const previewSubjects = new Set(
      activeSessions
        .filter(
          (session) =>
            session.subject.startsWith(PREVIEW_SESSION_SUBJECT_PREFIX) &&
            session.scopes?.includes(AuthBrowserPreviewScope) === true,
        )
        .map((session) => session.subject),
    );
    yield* Effect.forEach(previewSubjects, revokeSessionsForSubject, {
      concurrency: "unbounded",
      discard: true,
    });
    yield* Ref.set(attestationsRef, new Map());
  }).pipe(Effect.mapError(toManagedPreviewAuthError("Failed to revoke stale preview sessions.")));

  const revokeProviderSessionAccess = (providerSessionId: string) =>
    Effect.gen(function* () {
      yield* Ref.update(attestationsRef, (current) => {
        const next = new Map(current);
        for (const [challenge, record] of next) {
          if (record.providerSessionId === providerSessionId) next.delete(challenge);
        }
        return next;
      });
      const subject = makePreviewSubject(providerSessionId);
      yield* bootstrapCredentials.revokeTransientOneTimeTokensForSubject(subject);
      yield* revokeSessionsForSubject(subject);
    }).pipe(
      Effect.mapError(
        toManagedPreviewAuthError("Failed to revoke provider preview authorization."),
      ),
    );

  const prepare: ManagedPreviewAuth["Service"]["prepare"] = (input) =>
    Effect.gen(function* () {
      if (input.environmentId !== environmentId) return undefined;
      if (!input.capabilities.has("preview")) {
        yield* revokeProviderSessionAccess(input.providerSessionId);
        return yield* new ManagedPreviewAuthError({
          message: "Preview capability is no longer authorized.",
          reason: "authorization-revoked",
        });
      }
      if (!origins) return undefined;
      const target = resolveManagedTarget(input.operation, input.input, origins);
      if (!target) return undefined;

      if (!target.matches) {
        return {
          payload: {
            environmentId,
            expectedOrigins: target.expectedOrigins,
            bootstrapCredentials: [],
          },
          grantIds: [],
        } satisfies ManagedPreviewAuthGrant;
      }
      const now = yield* DateTime.now;
      const attestation = crypto.randomUUID();
      const attestationExpiresAt = DateTime.add(now, {
        milliseconds: Duration.toMillis(PREVIEW_ATTESTATION_TTL),
      });
      const initialAttestation: Attestation = {
        providerSessionId: input.providerSessionId,
        allowedOrigins: new Set(target.expectedOrigins),
        credentialHashes: new Map(),
        expiresAt: attestationExpiresAt,
      };
      yield* Ref.update(attestationsRef, (current) => {
        const next = new Map(
          Array.from(current).filter(
            ([, value]) => !DateTime.isGreaterThanOrEqualTo(now, value.expiresAt),
          ),
        );
        next.set(attestation, initialAttestation);
        return next;
      });

      // attest() and openBootstrap() reject any other origin.
      const credentialOrigins = automaticAuthAllowed ? target.expectedOrigins : [];
      const issued: Array<{
        readonly id: string;
        readonly origin: string;
        readonly credential: string;
      }> = [];
      const subject = makePreviewSubject(input.providerSessionId);
      for (const origin of credentialOrigins) {
        const result = yield* Effect.result(
          bootstrapCredentials.issueTransientBrowserSessionToken({
            ttl: PREVIEW_BOOTSTRAP_TTL,
            subject,
            label: PREVIEW_SESSION_LABEL,
          }),
        );
        if (result._tag === "Failure") {
          yield* Effect.forEach(
            issued,
            ({ id }) => bootstrapCredentials.revokeTransientOneTimeToken(id),
            { concurrency: "unbounded", discard: true },
          );
          yield* Ref.update(attestationsRef, (current) => {
            const next = new Map(current);
            next.delete(attestation);
            return next;
          });
          return yield* toManagedPreviewAuthError("Failed to issue managed preview credentials.")(
            result.failure,
          );
        }
        issued.push({
          id: result.success.id,
          origin,
          credential: result.success.credential,
        });
      }

      const grantStillActive = yield* Ref.modify(attestationsRef, (current) => {
        if (current.get(attestation) !== initialAttestation) return [false, current] as const;
        const next = new Map(current);
        next.set(attestation, {
          ...initialAttestation,
          credentialHashes: new Map(
            issued.map(({ origin, credential }) => [origin, hashCredential(credential)] as const),
          ),
        });
        return [true, next] as const;
      });
      if (!grantStillActive) {
        yield* Effect.forEach(
          issued,
          ({ id }) => bootstrapCredentials.revokeTransientOneTimeToken(id),
          { concurrency: "unbounded", discard: true },
        );
        return yield* new ManagedPreviewAuthError({
          message: "Preview authorization was revoked before credential exchange.",
          reason: "authorization-revoked",
        });
      }

      const payload: PreviewAutomationManagedTargetAuth = {
        environmentId,
        expectedOrigins: target.expectedOrigins,
        attestation,
        attestationPublicKey,
        bootstrapEncryptionPublicKey,
        bootstrapCredentials: issued.map(({ origin, credential }) => ({ origin, credential })),
      };
      return {
        payload,
        grantIds: issued.map(({ id }) => id),
      } satisfies ManagedPreviewAuthGrant;
    });

  const attest: ManagedPreviewAuth["Service"]["attest"] = (challenge, origin) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const record = yield* Ref.modify(attestationsRef, (current) => {
        const record = current.get(challenge);
        if (!record) return [undefined, current] as const;
        if (DateTime.isGreaterThanOrEqualTo(now, record.expiresAt)) {
          const next = new Map(current);
          next.delete(challenge);
          return [undefined, next] as const;
        }
        if (!record.allowedOrigins.has(origin)) return [undefined, current] as const;
        return [record, current] as const;
      });
      if (!record) return undefined;
      return signMessage(
        null,
        attestationMessage(environmentId, origin, challenge, bootstrapEncryptionPublicKey),
        keyPair.privateKey,
      ).toString("base64url");
    });

  const openBootstrap: ManagedPreviewAuth["Service"]["openBootstrap"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const record = yield* Ref.get(attestationsRef).pipe(
        Effect.map((current) => current.get(input.challenge)),
      );
      const expectedHashString = record?.credentialHashes.get(input.origin);
      if (
        !record ||
        DateTime.isGreaterThanOrEqualTo(now, record.expiresAt) ||
        !record.allowedOrigins.has(input.origin) ||
        !expectedHashString
      ) {
        return yield* new ManagedPreviewAuthError({
          message: "Managed preview bootstrap is no longer available.",
          reason: "bootstrap-failed",
        });
      }

      const cryptoContext: PreviewBootstrapCryptoContext = {
        environmentId,
        origin: input.origin,
        challenge: input.challenge,
        clientPublicKey: input.clientPublicKey,
        serverPublicKey: bootstrapEncryptionPublicKey,
      };
      const credential = yield* Effect.try({
        try: () =>
          openPreviewBootstrapPayload({
            privateKey: bootstrapKeyPair.privateKey,
            peerPublicKey: input.clientPublicKey,
            context: cryptoContext,
            direction: "request",
            encrypted: input.encryptedCredential,
          }),
        catch: (cause) =>
          new ManagedPreviewAuthError({
            message: "Managed preview bootstrap payload could not be decrypted.",
            reason: "bootstrap-failed",
            cause,
          }),
      });
      const expectedHash = Buffer.from(expectedHashString, "base64url");
      const receivedHash = Buffer.from(hashCredential(credential), "base64url");
      if (
        expectedHash.length !== receivedHash.length ||
        !timingSafeEqual(expectedHash, receivedHash)
      ) {
        return yield* new ManagedPreviewAuthError({
          message: "Managed preview bootstrap credential is invalid.",
          reason: "bootstrap-failed",
        });
      }

      const consumedAt = yield* DateTime.now;
      const consumed = yield* Ref.modify(attestationsRef, (current) => {
        if (
          current.get(input.challenge) !== record ||
          DateTime.isGreaterThanOrEqualTo(consumedAt, record.expiresAt)
        ) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.delete(input.challenge);
        return [true, next] as const;
      });
      if (!consumed) {
        return yield* new ManagedPreviewAuthError({
          message: "Managed preview bootstrap was already used.",
          reason: "bootstrap-failed",
        });
      }

      return {
        credential,
        encryptResponse: (plaintext) =>
          Effect.try({
            try: () =>
              sealPreviewBootstrapPayload({
                privateKey: bootstrapKeyPair.privateKey,
                peerPublicKey: input.clientPublicKey,
                context: cryptoContext,
                direction: "response",
                plaintext,
              }),
            catch: (cause) =>
              new ManagedPreviewAuthError({
                message: "Managed preview bootstrap response could not be encrypted.",
                reason: "bootstrap-failed",
                cause,
              }),
          }),
      };
    });

  const release: ManagedPreviewAuth["Service"]["release"] = (grant) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        grant.grantIds,
        (id) => bootstrapCredentials.revokeTransientOneTimeToken(id),
        { concurrency: "unbounded", discard: true },
      );
      yield* Ref.update(attestationsRef, (current) => {
        const next = new Map(current);
        if (grant.payload.attestation !== undefined) {
          next.delete(grant.payload.attestation);
        }
        return next;
      });
    }).pipe(
      Effect.mapError(toManagedPreviewAuthError("Failed to release managed preview grants.")),
    );

  const revokeProviderSession: ManagedPreviewAuth["Service"]["revokeProviderSession"] = (
    providerSessionId,
  ) => revokeProviderSessionAccess(providerSessionId);

  const service = ManagedPreviewAuth.of({
    prepare,
    attest,
    openBootstrap,
    release,
    revokeProviderSession,
    revokeAll,
  });
  yield* service.revokeAll;
  return service;
});

export const ManagedPreviewAuthLive = Layer.effect(ManagedPreviewAuth, makeManagedPreviewAuth);
