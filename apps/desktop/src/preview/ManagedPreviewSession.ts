import type {
  DesktopPreviewManagedSessionInput,
  DesktopPreviewManagedSessionResult,
} from "@t3tools/contracts";
import {
  AuthPreviewBootstrapResult,
  AuthPreviewBootstrapSession,
  AuthPreviewAttestationResult,
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import type { Session } from "electron";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  createPreviewBootstrapKeyPair,
  openPreviewBootstrapPayload,
  sealPreviewBootstrapPayload,
  type PreviewBootstrapCryptoContext,
} from "@t3tools/shared/previewBootstrapCrypto";

const MAX_MANAGED_SESSION_TIMEOUT_MS = 15_000;
const AUTH_POLL_INTERVAL_MS = 50;
const isEnvironmentDescriptor = Schema.is(ExecutionEnvironmentDescriptor);
const isPreviewAttestationResult = Schema.is(AuthPreviewAttestationResult);
const isPreviewBootstrapResult = Schema.is(AuthPreviewBootstrapResult);
const decodeAuthSessionState = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState));
const decodePreviewBootstrapSession = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthPreviewBootstrapSession),
);

type PreviewSessionFetch = Pick<Session, "fetch"> & {
  readonly cookies: Pick<Session["cookies"], "set">;
};

const attestationMessage = (
  environmentId: string,
  origin: string,
  challenge: string,
  bootstrapEncryptionPublicKey: string,
): Buffer =>
  Buffer.from(
    `${environmentId}\u0000${origin}\u0000${challenge}\u0000${bootstrapEncryptionPublicKey}`,
  );

const verifyAttestation = (
  environmentId: string,
  origin: string,
  challenge: string,
  bootstrapEncryptionPublicKey: string | undefined,
  publicKey: string | undefined,
  signature: string,
): boolean => {
  if (!publicKey || !bootstrapEncryptionPublicKey) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      type: "spki",
      format: "der",
    });
    return verifySignature(
      null,
      attestationMessage(environmentId, origin, challenge, bootstrapEncryptionPublicKey),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
};

const failed = (
  reason: Extract<DesktopPreviewManagedSessionResult, { _tag: "failed" }>["reason"],
): DesktopPreviewManagedSessionResult => ({ _tag: "failed", reason });

const boundedTimeout = (timeoutMs: number): number =>
  Math.min(Math.max(timeoutMs, AUTH_POLL_INTERVAL_MS), MAX_MANAGED_SESSION_TIMEOUT_MS);

const fetchWithTimeout = async (
  browserSession: PreviewSessionFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> => {
  try {
    return await browserSession.fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
};

const readJson = async (response: Response): Promise<unknown | null> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const readEnvironmentDescriptor = async (
  browserSession: PreviewSessionFetch,
  origin: string,
  timeoutMs: number,
): Promise<ExecutionEnvironmentDescriptor | null> => {
  const response = await fetchWithTimeout(
    browserSession,
    new URL("/.well-known/t3/environment", origin).toString(),
    {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    },
    timeoutMs,
  );
  if (!response?.ok) return null;
  const body = await readJson(response);
  return body !== null && isEnvironmentDescriptor(body) ? body : null;
};

const readSessionState = async (
  browserSession: PreviewSessionFetch,
  origin: string,
  timeoutMs: number,
): Promise<typeof AuthSessionState.Type | null> => {
  const response = await fetchWithTimeout(
    browserSession,
    new URL("/api/auth/session", origin).toString(),
    { method: "GET", credentials: "include", headers: { accept: "application/json" } },
    timeoutMs,
  );
  if (!response?.ok) return null;
  const body = await readJson(response);
  if (body === null) return null;
  try {
    return decodeAuthSessionState(body);
  } catch {
    return null;
  }
};

const authenticateTarget = async (
  browserSession: PreviewSessionFetch,
  input: DesktopPreviewManagedSessionInput,
): Promise<DesktopPreviewManagedSessionResult> => {
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  let targetUrl: URL;
  try {
    targetUrl = new URL(input.targetUrl);
  } catch {
    return { _tag: "not-managed" };
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return { _tag: "not-managed" };
  }

  const origin = targetUrl.origin;
  if (!input.managedTargetAuth.expectedOrigins.includes(origin)) {
    return failed("target-origin-mismatch");
  }
  const descriptor = await readEnvironmentDescriptor(browserSession, origin, remainingMs());
  if (Date.now() >= deadline) return failed("bootstrap-failed");
  if (!descriptor) return failed("target-instance-changed");
  if (
    descriptor.environmentId !== input.environmentId ||
    descriptor.environmentId !== input.managedTargetAuth.environmentId
  ) {
    return failed("foreign-environment");
  }
  if (!input.managedTargetAuth.attestation) {
    return failed("target-instance-changed");
  }

  const attestationResponse = await fetchWithTimeout(
    browserSession,
    new URL("/api/auth/preview-attestation", origin).toString(),
    {
      method: "POST",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ challenge: input.managedTargetAuth.attestation, origin }),
    },
    remainingMs(),
  );
  if (Date.now() >= deadline) return failed("bootstrap-failed");
  if (!attestationResponse?.ok) {
    return failed("target-instance-changed");
  }
  const attestationBody = await readJson(attestationResponse);
  if (
    attestationBody === null ||
    !isPreviewAttestationResult(attestationBody) ||
    !verifyAttestation(
      input.environmentId,
      origin,
      input.managedTargetAuth.attestation,
      input.managedTargetAuth.bootstrapEncryptionPublicKey,
      input.managedTargetAuth.attestationPublicKey,
      attestationBody.signature,
    )
  ) {
    return failed("target-instance-changed");
  }

  const sessionState = await readSessionState(browserSession, origin, remainingMs());
  if (Date.now() >= deadline) return failed("bootstrap-failed");
  if (!sessionState) return failed("bootstrap-failed");
  if (sessionState.authenticated) return { _tag: "authenticated" };

  switch (sessionState.unauthenticatedReason) {
    case "revoked":
      return failed("session-revoked");
    case "invalid":
      return failed("invalid-session");
    case "missing":
    case "expired":
      break;
    default:
      return failed("invalid-session");
  }

  const credential = input.managedTargetAuth.bootstrapCredentials.find(
    (entry) => entry.origin === origin,
  );
  if (!credential) return failed("pairing-required");
  const bootstrapEncryptionPublicKey = input.managedTargetAuth.bootstrapEncryptionPublicKey;
  if (!bootstrapEncryptionPublicKey) return failed("target-instance-changed");

  const clientKeyPair = createPreviewBootstrapKeyPair();
  const cryptoContext: PreviewBootstrapCryptoContext = {
    environmentId: input.environmentId,
    origin,
    challenge: input.managedTargetAuth.attestation,
    clientPublicKey: clientKeyPair.publicKey,
    serverPublicKey: bootstrapEncryptionPublicKey,
  };
  const encryptedCredential = sealPreviewBootstrapPayload({
    privateKey: clientKeyPair.privateKey,
    peerPublicKey: bootstrapEncryptionPublicKey,
    context: cryptoContext,
    direction: "request",
    plaintext: credential.credential,
  });

  const bootstrapResponse = await fetchWithTimeout(
    browserSession,
    new URL("/api/auth/preview-bootstrap", origin).toString(),
    {
      method: "POST",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        challenge: input.managedTargetAuth.attestation,
        origin,
        clientPublicKey: clientKeyPair.publicKey,
        encryptedCredential,
      }),
    },
    remainingMs(),
  );
  if (Date.now() >= deadline) return failed("bootstrap-failed");
  if (!bootstrapResponse?.ok) return failed("bootstrap-failed");
  const encryptedSession = await readJson(bootstrapResponse);
  if (encryptedSession === null || !isPreviewBootstrapResult(encryptedSession)) {
    return failed("bootstrap-failed");
  }
  const plaintextSession = openPreviewBootstrapPayload({
    privateKey: clientKeyPair.privateKey,
    peerPublicKey: bootstrapEncryptionPublicKey,
    context: cryptoContext,
    direction: "response",
    encrypted: encryptedSession,
  });
  let bootstrapSession: typeof AuthPreviewBootstrapSession.Type;
  try {
    bootstrapSession = decodePreviewBootstrapSession(JSON.parse(plaintextSession));
  } catch {
    return failed("bootstrap-failed");
  }
  if (
    bootstrapSession.response.role !== "client" ||
    bootstrapSession.response.sessionMethod !== "browser-session-cookie"
  ) {
    return failed("bootstrap-failed");
  }
  const expiresAt = DateTime.toEpochMillis(bootstrapSession.response.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 8 * 60 * 60 * 1_000 + 60_000
  ) {
    return failed("bootstrap-failed");
  }
  await browserSession.cookies.set({
    url: origin,
    name: sessionState.auth.sessionCookieName,
    value: bootstrapSession.sessionToken,
    path: "/",
    httpOnly: true,
    secure: targetUrl.protocol === "https:",
    sameSite: "lax",
    expirationDate: expiresAt / 1_000,
  });

  while (Date.now() <= deadline) {
    const state = await readSessionState(browserSession, origin, remainingMs());
    if (state?.authenticated) return { _tag: "authenticated" };
    if (state?.unauthenticatedReason === "revoked" || state?.unauthenticatedReason === "invalid") {
      return failed(
        state.unauthenticatedReason === "revoked" ? "session-revoked" : "invalid-session",
      );
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
  }
  return failed("bootstrap-failed");
};

const inFlightBySession = new WeakMap<
  PreviewSessionFetch,
  Map<string, Promise<DesktopPreviewManagedSessionResult>>
>();

export const bootstrapManagedPreviewSession = (
  browserSession: PreviewSessionFetch,
  input: DesktopPreviewManagedSessionInput,
): Promise<DesktopPreviewManagedSessionResult> => {
  let targetUrl: URL;
  try {
    targetUrl = new URL(input.targetUrl);
  } catch {
    return Promise.resolve({ _tag: "not-managed" });
  }
  const key = `${input.environmentId}\u0000${targetUrl.origin}\u0000${input.managedTargetAuth.attestation ?? ""}`;
  let inFlight = inFlightBySession.get(browserSession);
  if (!inFlight) {
    inFlight = new Map();
    inFlightBySession.set(browserSession, inFlight);
  }
  const existing = inFlight.get(key);
  if (existing) return existing;

  const operation = authenticateTarget(browserSession, input).catch(
    (): DesktopPreviewManagedSessionResult => failed("bootstrap-failed"),
  );
  inFlight.set(key, operation);
  void operation.finally(() => {
    if (inFlight?.get(key) === operation) inFlight.delete(key);
    if (inFlight?.size === 0) inFlightBySession.delete(browserSession);
  });
  return operation;
};
