import type { CreateCredentialResult, GetCredentialResult } from "electron-webauthn";

import { PASSKEY_CREATE_CHANNEL, PASSKEY_GET_CHANNEL } from "./GuestProtocol.ts";

/** What the main process answers a guest passkey ceremony with. */
export type PasskeyCeremonyResult =
  | Extract<CreateCredentialResult, { success: true }>
  | Extract<GetCredentialResult, { success: true }>
  | { readonly success: false; readonly error: string };

type PasskeyChannel = typeof PASSKEY_CREATE_CHANNEL | typeof PASSKEY_GET_CHANNEL;
// Credential Management Level 1 added `mediation` to creation requests.
type CreationOptions = CredentialCreationOptions & {
  readonly mediation?: CredentialMediationRequirement;
};
type InvokePasskeyCeremony = (channel: PasskeyChannel, publicKey: unknown) => Promise<unknown>;

const NOT_ALLOWED_MESSAGE =
  "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
const DOM_EXCEPTION_NAMES = new Set([
  "AbortError",
  "InvalidStateError",
  "NotAllowedError",
  "NotSupportedError",
  "SecurityError",
]);

const fromBase64Url = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
};

const toBase64Url = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const ceremonyError = (name: string) =>
  name === "TypeError"
    ? new TypeError("The passkey request options are invalid.")
    : new DOMException(
        NOT_ALLOWED_MESSAGE,
        DOM_EXCEPTION_NAMES.has(name) ? name : "NotAllowedError",
      );

/**
 * Copies request options into plain IPC-cloneable data. Chromium ignores
 * members it does not know, so functions and other uncloneable values drop out
 * here instead of failing the whole ceremony.
 */
const toCloneable = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (Array.isArray(value)) return value.map(toCloneable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, member]) =>
        typeof member === "function" || member === undefined ? [] : [[key, toCloneable(member)]],
      ),
    );
  }
  return value;
};

// The objects below borrow the native prototypes so `instanceof` checks pass.
// Their own properties shadow the native getters, which only work on objects
// Chromium created itself.
const withValues = <T extends object>(target: T, values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true });
  }
  return target;
};

const prfOutputs = (prf: {
  readonly enabled?: boolean;
  readonly results?: { readonly first?: string; readonly second?: string };
}): AuthenticationExtensionsPRFOutputs => {
  const first = prf.results?.first;
  const second = prf.results?.second;
  return {
    ...(prf.enabled === undefined ? {} : { enabled: prf.enabled }),
    ...(first === undefined
      ? {}
      : {
          results: {
            first: fromBase64Url(first),
            ...(second === undefined ? {} : { second: fromBase64Url(second) }),
          },
        }),
  };
};

const extensionResultsJson = (results: AuthenticationExtensionsClientOutputs) =>
  JSON.parse(
    JSON.stringify(results, (_key, value: unknown) =>
      value instanceof ArrayBuffer ? toBase64Url(value) : value,
    ),
  ) as unknown;

const makeCredential = (input: {
  readonly id: string;
  readonly authenticatorAttachment: AuthenticatorAttachment | null;
  readonly response: AuthenticatorResponse;
  readonly responseJson: Record<string, unknown>;
  readonly extensionResults: AuthenticationExtensionsClientOutputs;
}) =>
  withValues(Object.create(PublicKeyCredential.prototype) as PublicKeyCredential, {
    id: input.id,
    rawId: fromBase64Url(input.id),
    type: "public-key",
    authenticatorAttachment: input.authenticatorAttachment,
    response: input.response,
    getClientExtensionResults: () => input.extensionResults,
    toJSON: () => ({
      id: input.id,
      rawId: input.id,
      type: "public-key",
      ...(input.authenticatorAttachment === null
        ? {}
        : { authenticatorAttachment: input.authenticatorAttachment }),
      response: input.responseJson,
      clientExtensionResults: extensionResultsJson(input.extensionResults),
    }),
  });

const credentialFromCreateResult = (
  data: Extract<CreateCredentialResult, { success: true }>["data"],
) => {
  const transports = [...data.transports];
  const publicKey = data.publicKey.length > 0 ? data.publicKey : null;
  const extensionResults: AuthenticationExtensionsClientOutputs = {
    ...(data.extensions.credProps ? { credProps: { ...data.extensions.credProps } } : {}),
    ...(data.extensions.prf ? { prf: prfOutputs(data.extensions.prf) } : {}),
    ...(data.extensions.largeBlob ? { largeBlob: { ...data.extensions.largeBlob } } : {}),
  };
  return makeCredential({
    id: data.credentialId,
    // The native layer cannot tell a synced passkey from a security key.
    authenticatorAttachment: null,
    response: withValues(
      Object.create(AuthenticatorAttestationResponse.prototype) as AuthenticatorAttestationResponse,
      {
        clientDataJSON: fromBase64Url(data.clientDataJSON),
        attestationObject: fromBase64Url(data.attestationObject),
        getTransports: () => [...transports],
        getAuthenticatorData: () => fromBase64Url(data.authData),
        getPublicKey: () => (publicKey === null ? null : fromBase64Url(publicKey)),
        getPublicKeyAlgorithm: () => data.publicKeyAlgorithm,
      },
    ),
    responseJson: {
      clientDataJSON: data.clientDataJSON,
      attestationObject: data.attestationObject,
      authenticatorData: data.authData,
      transports,
      ...(publicKey === null ? {} : { publicKey }),
      publicKeyAlgorithm: data.publicKeyAlgorithm,
    },
    extensionResults,
  });
};

const credentialFromGetResult = (data: Extract<GetCredentialResult, { success: true }>["data"]) => {
  const userHandle = data.userHandle.length > 0 ? data.userHandle : null;
  const { prf, largeBlob } = data.extensions ?? {};
  const extensionResults: AuthenticationExtensionsClientOutputs = {
    ...(prf ? { prf: prfOutputs(prf) } : {}),
    ...(largeBlob
      ? {
          largeBlob: {
            ...(largeBlob.blob === undefined ? {} : { blob: fromBase64Url(largeBlob.blob) }),
            ...(largeBlob.written === undefined ? {} : { written: largeBlob.written }),
          },
        }
      : {}),
  };
  return makeCredential({
    id: data.credentialId,
    authenticatorAttachment: null,
    response: withValues(
      Object.create(AuthenticatorAssertionResponse.prototype) as AuthenticatorAssertionResponse,
      {
        clientDataJSON: fromBase64Url(data.clientDataJSON),
        authenticatorData: fromBase64Url(data.authenticatorData),
        signature: fromBase64Url(data.signature),
        userHandle: userHandle === null ? null : fromBase64Url(userHandle),
      },
    ),
    responseJson: {
      clientDataJSON: data.clientDataJSON,
      authenticatorData: data.authenticatorData,
      signature: data.signature,
      ...(userHandle === null ? {} : { userHandle }),
    },
    extensionResults,
  });
};

const abortReason = (signal: AbortSignal) =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/**
 * Routes this page's WebAuthn ceremonies to the system passkey sheet through
 * the main process, which supplies the frame's real origin. Runs in the page's
 * own world (the preview preload has contextIsolation off), before any page
 * script. Conditional (autofill and automatic upgrade) requests stay native:
 * the system sheet is modal and must not open on its own.
 */
export function installPasskeyBridge(invoke: InvokePasskeyCeremony) {
  // Insecure contexts have no WebAuthn to bridge.
  if (typeof CredentialsContainer === "undefined" || typeof PublicKeyCredential === "undefined") {
    return;
  }
  const run = async (
    channel: PasskeyChannel,
    publicKey: unknown,
    signal: AbortSignal | undefined,
  ): Promise<PublicKeyCredential> => {
    if (signal?.aborted) throw abortReason(signal);
    const ceremony = invoke(channel, toCloneable(publicKey)).then(
      (value) => {
        const result = value as PasskeyCeremonyResult;
        if (!result.success) throw ceremonyError(result.error);
        return "attestationObject" in result.data
          ? credentialFromCreateResult(result.data)
          : credentialFromGetResult(result.data);
      },
      // No handler yet (or any more) for this guest: answer like a refusal.
      (error: unknown) => {
        throw error instanceof DOMException || error instanceof TypeError
          ? error
          : ceremonyError("NotAllowedError");
      },
    );
    if (!signal) return ceremony;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      ceremony.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  const container = CredentialsContainer.prototype;
  const nativeCreate = container.create;
  const nativeGet = container.get;
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, configurable: true, writable: true });

  define(
    container,
    "create",
    function create(this: CredentialsContainer, options?: CreationOptions) {
      return options?.publicKey && options.mediation !== "conditional"
        ? run(PASSKEY_CREATE_CHANNEL, options.publicKey, options.signal)
        : Reflect.apply(nativeCreate, this, [options]);
    },
  );
  define(
    container,
    "get",
    function get(this: CredentialsContainer, options?: CredentialRequestOptions) {
      return options?.publicKey && options.mediation !== "conditional"
        ? run(PASSKEY_GET_CHANNEL, options.publicKey, options.signal)
        : Reflect.apply(nativeGet, this, [options]);
    },
  );

  define(PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", async () => true);
  define(PublicKeyCredential, "isConditionalMediationAvailable", async () => false);
  const nativeCapabilities = PublicKeyCredential.getClientCapabilities;
  if (typeof nativeCapabilities === "function") {
    define(PublicKeyCredential, "getClientCapabilities", async () => ({
      ...(await Reflect.apply(nativeCapabilities, PublicKeyCredential, [])),
      conditionalCreate: false,
      conditionalGet: false,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    }));
  }
}
