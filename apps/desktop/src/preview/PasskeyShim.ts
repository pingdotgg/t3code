// @effect-diagnostics cryptoRandomUUID:off - runs in a sandboxed page without an Effect runtime.
import type { PasskeyResult } from "./NativePasskeys.ts";

export interface PreviewPasskeyBridge {
  available: () => Promise<boolean>;
  request: (id: string, operation: string, options: unknown) => Promise<PasskeyResult | null>;
  cancel: (id: string) => void;
}

declare global {
  interface Window {
    __t3PreviewPasskeys: PreviewPasskeyBridge;
  }
}

/** Self-contained because Electron serializes this function into isolated popup main worlds. */
export function installPasskeyShim() {
  if (!window.isSecureContext || window.top !== window || !window.PublicKeyCredential) return;
  const bridge = window.__t3PreviewPasskeys;
  const credentials = navigator.credentials;
  const originalGet = credentials.get.bind(credentials);
  const originalCreate = credentials.create.bind(credentials);
  const originalAvailable =
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.bind(PublicKeyCredential);
  const encode = (value: unknown): unknown => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    return value;
  };
  const decode = (value: string) =>
    Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    ).buffer;
  const perform = async (
    operation: "get" | "create",
    publicKey: PublicKeyCredentialRequestOptions | PublicKeyCredentialCreationOptions,
    signal: AbortSignal | undefined,
    fallback: () => Promise<Credential | null>,
  ) => {
    if (signal?.aborted) throw signal.reason;
    const id = crypto.randomUUID();
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => {
        bridge.cancel(id);
        reject(signal?.reason ?? new DOMException("Request aborted.", "AbortError"));
      };
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await Promise.race([
        bridge.request(id, operation, encode(publicKey)),
        aborted,
      ]);
      if (result === null) return fallback();
      if ("error" in result)
        throw new DOMException("The passkey request could not be completed.", result.error);
      const response = Object.create(
        operation === "get"
          ? AuthenticatorAssertionResponse.prototype
          : AuthenticatorAttestationResponse.prototype,
      );
      for (const [key, value] of Object.entries(result.response)) {
        if (typeof value === "string")
          Object.defineProperty(response, key, {
            value: key === "userHandle" && !value ? null : decode(value),
            enumerable: true,
          });
      }
      if (operation === "create")
        Object.defineProperties(response, {
          getTransports: { value: () => ["internal", "hybrid"] },
          getAuthenticatorData: { value: () => response.authenticatorData },
          getPublicKey: { value: () => response.publicKey ?? null },
          getPublicKeyAlgorithm: { value: () => result.response.publicKeyAlgorithm },
        });
      const extensionResults = result.clientExtensionResults ?? {};
      const json = {
        id: result.id,
        rawId: result.id,
        type: "public-key",
        authenticatorAttachment: result.authenticatorAttachment,
        response: {
          ...Object.fromEntries(
            Object.entries(result.response).filter(([key, value]) => key !== "userHandle" || value),
          ),
          ...(operation === "create" ? { transports: ["internal", "hybrid"] } : {}),
        },
        clientExtensionResults: extensionResults,
      };
      return Object.create(PublicKeyCredential.prototype, {
        id: { value: result.id, enumerable: true },
        rawId: { value: decode(result.id), enumerable: true },
        type: { value: "public-key", enumerable: true },
        response: { value: response, enumerable: true },
        authenticatorAttachment: { value: result.authenticatorAttachment, enumerable: true },
        getClientExtensionResults: { value: () => structuredClone(extensionResults) },
        toJSON: { value: () => structuredClone(json) },
      }) as PublicKeyCredential;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  credentials.get = (options) =>
    options?.publicKey && options.mediation !== "conditional"
      ? perform("get", options.publicKey, options.signal, () => originalGet(options))
      : originalGet(options);
  credentials.create = (options) =>
    options?.publicKey &&
    options.publicKey.authenticatorSelection?.authenticatorAttachment !== "cross-platform"
      ? perform("create", options.publicKey, options.signal, () => originalCreate(options))
      : originalCreate(options);
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () =>
    (await bridge.available()) || originalAvailable();
  const originalCapabilities = PublicKeyCredential.getClientCapabilities?.bind(PublicKeyCredential);
  if (originalCapabilities)
    PublicKeyCredential.getClientCapabilities = async () => ({
      ...(await originalCapabilities()),
      conditionalGet: false,
      conditionalCreate: false,
      userVerifyingPlatformAuthenticator:
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    });
  // The native sheet is explicit only; don't cause an OS prompt when a page probes autofill.
  PublicKeyCredential.isConditionalMediationAvailable = async () => false;
}
