import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthBrowserPreviewScope, EnvironmentId, type AuthClientSession } from "@t3tools/contracts";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { Context, DateTime, Duration, Effect, Layer, Result } from "effect";
import { HttpServer } from "effect/unstable/http";
import {
  createPreviewBootstrapKeyPair,
  openPreviewBootstrapPayload,
  sealPreviewBootstrapPayload,
  type PreviewBootstrapCryptoContext,
} from "@t3tools/shared/previewBootstrapCrypto";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import {
  BootstrapCredentialError,
  BootstrapCredentialService,
} from "../Services/BootstrapCredentialService.ts";
import { ManagedPreviewAuth } from "../Services/ManagedPreviewAuth.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";
import { ManagedPreviewAuthLive } from "./ManagedPreviewAuth.ts";

const environmentId = EnvironmentId.make("environment-managed");
const origin = "http://127.0.0.1:6270";
const previewSubject = (providerSessionId: string) => `t3-browser-preview:${providerSessionId}`;

const makeManagedPreviewAuthLayer = () => {
  let nextCredential = 0;
  const issued = new Map<string, { readonly credential: string; readonly subject: string }>();
  const revokedSubjects = new Set<string>();
  const revokedSessions: string[] = [];
  let activeSessions: ReadonlyArray<AuthClientSession> = [];

  const bootstrapCredentials = Layer.mock(BootstrapCredentialService)({
    issueTransientBrowserSessionToken: (input) =>
      Effect.gen(function* () {
        if (revokedSubjects.has(input.subject)) {
          return yield* new BootstrapCredentialError({
            message: "Preview subject was already revoked.",
            status: 401,
          });
        }
        const sequence = ++nextCredential;
        const id = `preview-grant-${sequence}`;
        const credential = `transient-preview-credential-${sequence}`;
        const now = yield* DateTime.now;
        issued.set(id, { credential, subject: input.subject });
        return {
          id,
          credential,
          scopes: [AuthBrowserPreviewScope],
          ...(input.label === undefined ? {} : { label: input.label }),
          expiresAt: DateTime.toUtc(
            DateTime.add(now, { milliseconds: Duration.toMillis(input.ttl) }),
          ),
        };
      }),
    revokeTransientOneTimeToken: (id) =>
      Effect.sync(() => {
        const existed = issued.has(id);
        issued.delete(id);
        return existed;
      }),
    revokeTransientOneTimeTokensForSubject: (subject) =>
      Effect.sync(() => {
        revokedSubjects.add(subject);
        let count = 0;
        for (const [id, token] of issued) {
          if (token.subject === subject) {
            issued.delete(id);
            count += 1;
          }
        }
        return count;
      }),
    isTransientSubjectRevoked: (subject) => Effect.sync(() => revokedSubjects.has(subject)),
  });
  const sessions = Layer.mock(SessionCredentialService)({
    cookieName: "t3_session",
    listActive: () => Effect.succeed(activeSessions),
    revoke: (sessionId) =>
      Effect.sync(() => {
        revokedSessions.push(sessionId);
        return true;
      }),
  });
  const serverAuthPolicy = Layer.succeed(
    ServerAuthPolicy,
    ServerAuthPolicy.of({
      getDescriptor: () =>
        Effect.succeed({
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap", "one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        }),
    }),
  );
  const serverEnvironment = Layer.succeed(
    ServerEnvironment,
    ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("ManagedPreviewAuth only reads the environment id."),
    }),
  );
  const httpServer = Layer.succeed(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 6270 },
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  );
  const layer = ManagedPreviewAuthLive.pipe(
    Layer.provide(bootstrapCredentials),
    Layer.provide(sessions),
    Layer.provide(serverAuthPolicy),
    Layer.provide(serverEnvironment),
    Layer.provide(httpServer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "managed-preview-auth-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    issued,
    revokedSessions,
    setActiveSessions: (next: ReadonlyArray<AuthClientSession>) => {
      activeSessions = next;
    },
  };
};

const makePrepareInput = (overrides?: {
  readonly environmentId?: EnvironmentId;
  readonly providerSessionId?: string;
  readonly capabilities?: ReadonlySet<string>;
}) => ({
  environmentId: overrides?.environmentId ?? environmentId,
  providerSessionId: overrides?.providerSessionId ?? "provider-session-1",
  capabilities: overrides?.capabilities ?? new Set(["preview"]),
  operation: "open" as const,
  input: { url: origin },
});

it.layer(NodeServices.layer)("ManagedPreviewAuthLive", (it) => {
  it.effect("binds an encrypted one-use exchange to the attested target origin", () => {
    const fixture = makeManagedPreviewAuthLayer();
    return Effect.gen(function* () {
      const context = yield* Layer.build(fixture.layer);
      const auth = Context.get(context, ManagedPreviewAuth);
      const grant = yield* auth.prepare(makePrepareInput());
      expect(grant).toBeDefined();
      if (!grant) return;

      const managedTargetAuth = grant.payload;
      expect(managedTargetAuth.expectedOrigins).toEqual([origin]);
      // Credentials must be issued only for attested origins: attest() and
      // openBootstrap() reject every other origin, so wider issuance would only
      // widen exposure inside managedTargetAuth.
      expect(managedTargetAuth.bootstrapCredentials.map((entry) => entry.origin)).toEqual([origin]);
      const challenge = managedTargetAuth.attestation;
      const signingPublicKey = managedTargetAuth.attestationPublicKey;
      const serverPublicKey = managedTargetAuth.bootstrapEncryptionPublicKey;
      expect(challenge).toBeDefined();
      expect(signingPublicKey).toBeDefined();
      expect(serverPublicKey).toBeDefined();
      if (!challenge || !signingPublicKey || !serverPublicKey) return;

      const signingKey = createPublicKey({
        key: Buffer.from(signingPublicKey, "base64url"),
        format: "der",
        type: "spki",
      });
      const signature = yield* auth.attest(challenge, origin);
      expect(signature).toBeDefined();
      if (!signature) return;
      const signedMessage = Buffer.from(
        `${environmentId}\u0000${origin}\u0000${challenge}\u0000${serverPublicKey}`,
      );
      expect(
        verifySignature(null, signedMessage, signingKey, Buffer.from(signature, "base64url")),
      ).toBe(true);

      const credential = managedTargetAuth.bootstrapCredentials.find(
        (entry) => entry.origin === origin,
      );
      expect(credential).toBeDefined();
      if (!credential) return;
      const clientKeys = createPreviewBootstrapKeyPair();
      const cryptoContext: PreviewBootstrapCryptoContext = {
        environmentId,
        origin,
        challenge,
        clientPublicKey: clientKeys.publicKey,
        serverPublicKey,
      };
      const encryptedCredential = sealPreviewBootstrapPayload({
        privateKey: clientKeys.privateKey,
        peerPublicKey: serverPublicKey,
        context: cryptoContext,
        direction: "request",
        plaintext: credential.credential,
      });
      const request = {
        challenge,
        origin,
        clientPublicKey: clientKeys.publicKey,
        encryptedCredential,
      };
      expect(JSON.stringify(request)).not.toContain(credential.credential);

      const exchanges = yield* Effect.all(
        [Effect.result(auth.openBootstrap(request)), Effect.result(auth.openBootstrap(request))],
        { concurrency: "unbounded" },
      );
      const success = exchanges.find(Result.isSuccess);
      expect(exchanges.filter(Result.isSuccess)).toHaveLength(1);
      if (!success || !Result.isSuccess(success)) return;

      const encryptedSession = yield* success.success.encryptResponse("session-cookie-token");
      expect(
        openPreviewBootstrapPayload({
          privateKey: clientKeys.privateKey,
          peerPublicKey: serverPublicKey,
          context: cryptoContext,
          direction: "response",
          encrypted: encryptedSession,
        }),
      ).toBe("session-cookie-token");
      expect(yield* auth.attest(challenge, origin)).toBeUndefined();
    });
  });

  it.effect(
    "denies foreign environments and revokes grants and sessions when preview is removed",
    () => {
      const fixture = makeManagedPreviewAuthLayer();
      return Effect.gen(function* () {
        const context = yield* Layer.build(fixture.layer);
        const auth = Context.get(context, ManagedPreviewAuth);
        expect(
          yield* auth.prepare(
            makePrepareInput({ environmentId: EnvironmentId.make("environment-other") }),
          ),
        ).toBeUndefined();

        const providerSessionId = "provider-session-revoked";
        const grant = yield* auth.prepare(makePrepareInput({ providerSessionId }));
        expect(grant).toBeDefined();
        if (!grant) return;
        const sessionId = "preview-session-revoked" as AuthClientSession["sessionId"];
        fixture.setActiveSessions([
          {
            sessionId,
            subject: previewSubject(providerSessionId),
            scopes: [AuthBrowserPreviewScope],
          } as unknown as AuthClientSession,
        ]);

        const denied = yield* Effect.result(
          auth.prepare(
            makePrepareInput({
              providerSessionId,
              capabilities: new Set(),
            }),
          ),
        );
        expect(denied._tag).toBe("Failure");
        if (denied._tag === "Failure") {
          expect(denied.failure.reason).toBe("authorization-revoked");
        }
        expect(fixture.revokedSessions).toContain(sessionId);
        expect(
          Array.from(fixture.issued.values()).some(
            (token) => token.subject === previewSubject(providerSessionId),
          ),
        ).toBe(false);
        expect(yield* auth.attest(grant.payload.attestation ?? "", origin)).toBeUndefined();

        const retry = yield* Effect.result(auth.prepare(makePrepareInput({ providerSessionId })));
        expect(retry._tag).toBe("Failure");
        if (retry._tag === "Failure") {
          expect(retry.failure.reason).toBe("bootstrap-failed");
        }
      });
    },
  );
});
