import { EnvironmentId } from "@t3tools/contracts";
import {
  AuthPreviewBootstrapResult,
  type AuthPreviewBootstrapInput,
  type DesktopPreviewManagedSessionInput,
  type PreviewAutomationManagedTargetAuth,
} from "@t3tools/contracts";
import { generateKeyPairSync, sign as signMessage, type KeyObject } from "node:crypto";
import type { Session } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createPreviewBootstrapKeyPair,
  openPreviewBootstrapPayload,
  sealPreviewBootstrapPayload,
  type PreviewBootstrapCryptoContext,
} from "@t3tools/shared/previewBootstrapCrypto";

import { bootstrapManagedPreviewSession } from "./ManagedPreviewSession.ts";

const environmentId = EnvironmentId.make("environment-managed");
const defaultOrigin = "http://127.0.0.1:6270";
const attestation = "challenge-managed-preview";
const future = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString();
const authDescriptor = {
  policy: "desktop-managed-local" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["browser-session-cookie" as const],
  sessionCookieName: "t3_session",
};

const makeManagedTargetAuth = (input: {
  readonly origin?: string;
  readonly expectedOrigins?: ReadonlyArray<string>;
  readonly signingPublicKey?: string;
  readonly encryptionPublicKey?: string;
  readonly credentials?: ReadonlyArray<{ readonly origin: string; readonly credential: string }>;
}): PreviewAutomationManagedTargetAuth => ({
  environmentId,
  expectedOrigins: input.expectedOrigins ?? [input.origin ?? defaultOrigin],
  attestation,
  ...(input.signingPublicKey === undefined ? {} : { attestationPublicKey: input.signingPublicKey }),
  ...(input.encryptionPublicKey === undefined
    ? {}
    : { bootstrapEncryptionPublicKey: input.encryptionPublicKey }),
  bootstrapCredentials: input.credentials ?? [
    {
      origin: input.origin ?? defaultOrigin,
      credential: "transient-preview-credential",
    },
  ],
});

const makeInput = (
  managedTargetAuth: PreviewAutomationManagedTargetAuth,
  targetUrl = defaultOrigin,
): DesktopPreviewManagedSessionInput => ({
  environmentId,
  profileId: "default",
  targetUrl,
  managedTargetAuth,
  timeoutMs: 2_000,
});

const makeHarness = (options?: {
  readonly initialState?: "authenticated" | "missing" | "expired" | "revoked" | "invalid";
  readonly descriptorEnvironmentId?: string;
  readonly descriptorMissing?: boolean;
  readonly currentSigningKey?: KeyObject;
  readonly currentEncryptionKey?: ReturnType<typeof createPreviewBootstrapKeyPair>;
  readonly managedTargetAuth?: PreviewAutomationManagedTargetAuth;
}) => {
  const signingKeyPair = options?.currentSigningKey ? undefined : generateKeyPairSync("ed25519");
  const encryptionKeyPair = options?.currentEncryptionKey ?? createPreviewBootstrapKeyPair();
  const signingPrivateKey = options?.currentSigningKey ?? signingKeyPair!.privateKey;
  const signingPublicKey = signingKeyPair?.publicKey;
  const credential = "transient-preview-credential";
  const managedTargetAuth =
    options?.managedTargetAuth ??
    makeManagedTargetAuth({
      ...(signingPublicKey === undefined
        ? {}
        : {
            signingPublicKey: signingPublicKey
              .export({ type: "spki", format: "der" })
              .toString("base64url"),
          }),
      encryptionPublicKey: encryptionKeyPair.publicKey,
      credentials: [{ origin: defaultOrigin, credential }],
    });
  let authenticated = options?.initialState === "authenticated";
  const bootstrapRequests: AuthPreviewBootstrapInput[] = [];
  const stages: string[] = [];
  const cookieSet = vi.fn(async (_details: Parameters<Session["cookies"]["set"]>[0]) => {
    stages.push("cookie-set");
    authenticated = true;
  });
  const fetch = vi.fn<Session["fetch"]>(async (request, init) => {
    const url = new URL(String(request));
    if (url.pathname === "/.well-known/t3/environment") {
      stages.push("descriptor");
      if (options?.descriptorMissing) return new Response(null, { status: 404 });
      return new Response(
        JSON.stringify({
          environmentId: options?.descriptorEnvironmentId ?? environmentId,
          label: "Managed test environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "test",
          capabilities: { repositoryIdentity: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/auth/preview-attestation") {
      stages.push("attestation");
      const signature = signMessage(
        null,
        Buffer.from(
          `${environmentId}\u0000${url.origin}\u0000${attestation}\u0000${encryptionKeyPair.publicKey}`,
        ),
        signingPrivateKey,
      ).toString("base64url");
      return new Response(JSON.stringify({ signature }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/auth/session") {
      stages.push("session");
      const state =
        authenticated === true
          ? {
              authenticated: true,
              auth: authDescriptor,
              role: "client",
              scopes: ["preview:browser"],
              sessionMethod: "browser-session-cookie",
              expiresAt: future,
            }
          : {
              authenticated: false,
              auth: authDescriptor,
              unauthenticatedReason: options?.initialState ?? "missing",
            };
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/auth/preview-bootstrap") {
      stages.push("bootstrap-request");
      const payload = JSON.parse(String(init?.body)) as AuthPreviewBootstrapInput;
      bootstrapRequests.push(payload);
      const cryptoContext: PreviewBootstrapCryptoContext = {
        environmentId,
        origin: url.origin,
        challenge: payload.challenge,
        clientPublicKey: payload.clientPublicKey,
        serverPublicKey: encryptionKeyPair.publicKey,
      };
      const openedCredential = openPreviewBootstrapPayload({
        privateKey: encryptionKeyPair.privateKey,
        peerPublicKey: payload.clientPublicKey,
        context: cryptoContext,
        direction: "request",
        encrypted: payload.encryptedCredential,
      });
      stages.push("bootstrap-decrypted");
      if (openedCredential !== credential) {
        return new Response(null, { status: 401 });
      }
      const encrypted = sealPreviewBootstrapPayload({
        privateKey: encryptionKeyPair.privateKey,
        peerPublicKey: payload.clientPublicKey,
        context: cryptoContext,
        direction: "response",
        plaintext: JSON.stringify({
          response: {
            authenticated: true,
            role: "client",
            sessionMethod: "browser-session-cookie",
            expiresAt: future,
          },
          sessionToken: "encrypted-session-cookie",
        }),
      });
      stages.push("bootstrap-response");
      return new Response(
        JSON.stringify(encrypted satisfies typeof AuthPreviewBootstrapResult.Type),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(null, { status: 404 });
  });
  return {
    managedTargetAuth,
    browserSession: { fetch, cookies: { set: cookieSet } },
    bootstrapRequests,
    cookieSet,
    stages,
  };
};

describe("bootstrapManagedPreviewSession", () => {
  it("reuses a valid session without exchanging another credential", async () => {
    const harness = makeHarness({ initialState: "authenticated" });

    await expect(
      bootstrapManagedPreviewSession(harness.browserSession, makeInput(harness.managedTargetAuth)),
    ).resolves.toEqual({ _tag: "authenticated" });
    expect(harness.bootstrapRequests).toHaveLength(0);
    expect(harness.cookieSet).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired"] as const)(
    "establishes a scoped browser cookie after a %s session",
    async (initialState) => {
      const harness = makeHarness({ initialState });

      const result = await bootstrapManagedPreviewSession(
        harness.browserSession,
        makeInput(harness.managedTargetAuth),
      );
      expect(harness.bootstrapRequests).toHaveLength(1);
      expect(harness.stages).toContain("bootstrap-response");
      expect(harness.cookieSet).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ _tag: "authenticated" });
      expect(JSON.stringify(harness.bootstrapRequests[0])).not.toContain(
        "transient-preview-credential",
      );
      expect(harness.browserSession.fetch).toHaveBeenCalledWith(
        `${defaultOrigin}/api/auth/preview-bootstrap`,
        expect.objectContaining({ credentials: "omit" }),
      );
      expect(harness.cookieSet).toHaveBeenCalledWith(
        expect.objectContaining({
          url: defaultOrigin,
          name: "t3_session",
          value: "encrypted-session-cookie",
          httpOnly: true,
          secure: false,
          sameSite: "lax",
        }),
      );
    },
  );

  it.each(["revoked", "invalid"] as const)(
    "does not reauthorize a %s session",
    async (initialState) => {
      const harness = makeHarness({ initialState });

      await expect(
        bootstrapManagedPreviewSession(
          harness.browserSession,
          makeInput(harness.managedTargetAuth),
        ),
      ).resolves.toEqual({
        _tag: "failed",
        reason: initialState === "revoked" ? "session-revoked" : "invalid-session",
      });
      expect(harness.bootstrapRequests).toHaveLength(0);
      expect(harness.cookieSet).not.toHaveBeenCalled();
    },
  );

  it("coalesces concurrent opens against one profile session", async () => {
    const harness = makeHarness({ initialState: "missing" });
    const input = makeInput(harness.managedTargetAuth);

    const results = await Promise.all([
      bootstrapManagedPreviewSession(harness.browserSession, input),
      bootstrapManagedPreviewSession(harness.browserSession, input),
    ]);
    expect(harness.bootstrapRequests).toHaveLength(1);
    expect(results).toEqual([{ _tag: "authenticated" }, { _tag: "authenticated" }]);
    expect(harness.cookieSet).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicitly authorized loopback host alias", async () => {
    const signingKeyPair = generateKeyPairSync("ed25519");
    const encryptionKeyPair = createPreviewBootstrapKeyPair();
    const aliasOrigin = "http://localhost:6270";
    const signingPublicKey = signingKeyPair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const managedTargetAuth = makeManagedTargetAuth({
      origin: aliasOrigin,
      expectedOrigins: [defaultOrigin, aliasOrigin],
      signingPublicKey,
      encryptionPublicKey: encryptionKeyPair.publicKey,
      credentials: [
        { origin: defaultOrigin, credential: "other-origin-credential" },
        { origin: aliasOrigin, credential: "transient-preview-credential" },
      ],
    });
    const harness = makeHarness({
      initialState: "missing",
      currentSigningKey: signingKeyPair.privateKey,
      currentEncryptionKey: encryptionKeyPair,
      managedTargetAuth,
    });

    const result = await bootstrapManagedPreviewSession(
      harness.browserSession,
      makeInput(managedTargetAuth, aliasOrigin),
    );
    expect(harness.bootstrapRequests).toHaveLength(1);
    expect(result).toEqual({ _tag: "authenticated" });
    expect(harness.cookieSet).toHaveBeenCalledWith(expect.objectContaining({ url: aliasOrigin }));
  });

  it("rejects a changed server instance and a foreign environment", async () => {
    const oldSigningKey = generateKeyPairSync("ed25519");
    const oldEncryptionKey = createPreviewBootstrapKeyPair();
    const oldManagedAuth = makeManagedTargetAuth({
      signingPublicKey: oldSigningKey.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      encryptionPublicKey: oldEncryptionKey.publicKey,
    });
    const restartedServer = makeHarness({
      initialState: "missing",
      currentSigningKey: generateKeyPairSync("ed25519").privateKey,
      currentEncryptionKey: createPreviewBootstrapKeyPair(),
      managedTargetAuth: oldManagedAuth,
    });
    await expect(
      bootstrapManagedPreviewSession(restartedServer.browserSession, makeInput(oldManagedAuth)),
    ).resolves.toEqual({ _tag: "failed", reason: "target-instance-changed" });
    expect(restartedServer.bootstrapRequests).toHaveLength(0);

    const foreignEnvironment = makeHarness({
      descriptorEnvironmentId: "environment-other",
    });
    await expect(
      bootstrapManagedPreviewSession(
        foreignEnvironment.browserSession,
        makeInput(foreignEnvironment.managedTargetAuth),
      ),
    ).resolves.toEqual({ _tag: "failed", reason: "foreign-environment" });
    expect(foreignEnvironment.bootstrapRequests).toHaveLength(0);
  });

  it("rejects a missing T3 descriptor at the authorized origin", async () => {
    const harness = makeHarness({ descriptorMissing: true });

    await expect(
      bootstrapManagedPreviewSession(harness.browserSession, makeInput(harness.managedTargetAuth)),
    ).resolves.toEqual({ _tag: "failed", reason: "target-instance-changed" });
    expect(harness.bootstrapRequests).toHaveLength(0);
  });

  it("rejects an origin outside the exact authorized alias set", async () => {
    const harness = makeHarness();

    await expect(
      bootstrapManagedPreviewSession(
        harness.browserSession,
        makeInput(harness.managedTargetAuth, "http://localhost:6270"),
      ),
    ).resolves.toEqual({ _tag: "failed", reason: "target-origin-mismatch" });
    expect(harness.browserSession.fetch).not.toHaveBeenCalled();
  });
});
