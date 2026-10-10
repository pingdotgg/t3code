// @effect-diagnostics nodeBuiltinImport:off - Runs inside Playwright binding callbacks, outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import { getPublicSuffix, parse } from "tldts";

/**
 * Passkeys for server browser pages, served by the controlling viewer's device.
 * Headless Chromium has no authenticator, so a page's WebAuthn request travels
 * to the viewer, whose system passkey sheet answers it. This module holds the
 * page script and the checks a browser owes the relying party: the origin comes
 * from Chromium, never from the page, the RP ID must belong to it, and a
 * credential must be the one this ceremony asked for.
 */

export const PASSKEY_BINDING = "__t3PreviewPasskey";
/** A page's request reaches a viewer only this soon after it last touched the page. */
export const PASSKEY_GESTURE_MS = 10_000;
// Chromium clamps WebAuthn timeouts to the same range.
const MIN_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
// Passkeys on Apple devices are P-256 keys.
const ES256 = -7;
const ERROR_NAMES = [
  "AbortError",
  "InvalidStateError",
  "NotAllowedError",
  "NotSupportedError",
  "SecurityError",
  "TypeError",
];

/**
 * Routes the page's WebAuthn ceremonies through the binding. The server answers
 * `native` when no viewer holds passkeys, and the page keeps Chromium's own
 * WebAuthn. Conditional requests (autofill, automatic upgrades) always stay
 * native: the device's sheet must not open on its own.
 */
export const PASSKEY_SCRIPT = `(() => {
  if (typeof CredentialsContainer === "undefined" || typeof PublicKeyCredential === "undefined") return;
  const ask = (...args) => new Promise((resolve) => resolve(globalThis.${PASSKEY_BINDING}(...args)));
  const bytesOf = (value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const toBase64Url = (value) => {
    let binary = "";
    for (const byte of bytesOf(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  const fromBase64Url = (text) => {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  };
  // Options cross in WebAuthn's JSON form: binary members as base64url.
  const toJson = (value) => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return toBase64Url(value);
    if (Array.isArray(value)) return value.map(toJson);
    if (typeof value !== "object" || value === null) return value;
    const json = {};
    for (const [key, member] of Object.entries(value))
      if (typeof member !== "function" && member !== undefined) json[key] = toJson(member);
    return json;
  };
  const failure = (name) =>
    name === "TypeError"
      ? new TypeError("The passkey request options are invalid.")
      : new DOMException(
          "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
          ${JSON.stringify(ERROR_NAMES)}.includes(name) ? name : "NotAllowedError",
        );
  // Own properties shadow the native getters, which only work on objects Chromium made.
  const withValues = (target, values) => {
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true });
    return target;
  };
  const credentialFrom = (json) => {
    const response = json.response;
    return withValues(Object.create(PublicKeyCredential.prototype), {
      id: json.id,
      rawId: fromBase64Url(json.rawId),
      type: "public-key",
      authenticatorAttachment: json.authenticatorAttachment,
      response:
        "attestationObject" in response
          ? withValues(Object.create(AuthenticatorAttestationResponse.prototype), {
              clientDataJSON: fromBase64Url(response.clientDataJSON),
              attestationObject: fromBase64Url(response.attestationObject),
              getTransports: () => [...response.transports],
              getAuthenticatorData: () => fromBase64Url(response.authenticatorData),
              getPublicKey: () => (response.publicKey === undefined ? null : fromBase64Url(response.publicKey)),
              getPublicKeyAlgorithm: () => response.publicKeyAlgorithm,
            })
          : withValues(Object.create(AuthenticatorAssertionResponse.prototype), {
              clientDataJSON: fromBase64Url(response.clientDataJSON),
              authenticatorData: fromBase64Url(response.authenticatorData),
              signature: fromBase64Url(response.signature),
              userHandle: response.userHandle === undefined ? null : fromBase64Url(response.userHandle),
            }),
      getClientExtensionResults: () => structuredClone(json.clientExtensionResults),
      toJSON: () => structuredClone(json),
    });
  };
  let tickets = 0;
  const run = async (native, self, kind, options) => {
    const signal = options.signal;
    const abortReason = () => signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) throw abortReason();
    let request;
    try {
      request = toJson(options.publicKey);
    } catch {
      throw failure("TypeError");
    }
    const ticket = ++tickets;
    const answered = ask(kind, ticket, request).catch(() => ({ error: "NotAllowedError" }));
    let onAbort = null;
    const aborted = signal
      ? new Promise((resolve) => {
          onAbort = () => resolve({ aborted: true });
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;
    const answer = await (aborted ? Promise.race([answered, aborted]) : answered);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (answer?.aborted) {
      void ask("abort", ticket).catch(() => {});
      throw abortReason();
    }
    if (answer?.native) return Reflect.apply(native, self, [options]);
    if (answer?.credential) return credentialFrom(answer.credential);
    throw failure(answer?.error);
  };
  const container = CredentialsContainer.prototype;
  for (const [kind, native] of [["create", container.create], ["get", container.get]]) {
    Object.defineProperty(container, kind, {
      configurable: true,
      writable: true,
      value: function (options) {
        return options?.publicKey && options.mediation !== "conditional"
          ? run(native, this, kind, options)
          : Reflect.apply(native, this, [options]);
      },
    });
  }
  const available = () => ask("available").then((value) => value === true, () => false);
  const nativeAvailable = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof nativeAvailable === "function") {
    Object.defineProperty(PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", {
      configurable: true,
      writable: true,
      value: async () => (await available()) || Reflect.apply(nativeAvailable, PublicKeyCredential, []),
    });
  }
  const nativeCapabilities = PublicKeyCredential.getClientCapabilities;
  if (typeof nativeCapabilities === "function") {
    Object.defineProperty(PublicKeyCredential, "getClientCapabilities", {
      configurable: true,
      writable: true,
      value: async () => {
        const capabilities = await Reflect.apply(nativeCapabilities, PublicKeyCredential, []);
        return (await available())
          ? { ...capabilities, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true }
          : capabilities;
      },
    });
  }
})();`;

type Json = Readonly<Record<string, unknown>>;

/** A page's request that passed the server's checks, ready for the viewer. */
export interface PasskeyRequest {
  readonly kind: "create" | "get";
  readonly origin: string;
  readonly rpId: string;
  readonly challenge: string;
  /** The page's options in WebAuthn's JSON form, with the RP ID filled in. */
  readonly publicKey: Json;
  readonly timeoutMs: number;
  /** Credential IDs a sign-in accepts; empty means any of this site's. */
  readonly allowCredentials: ReadonlyArray<string>;
  readonly credProps: boolean;
}

/** What the page script receives: a credential in `PublicKeyCredential.toJSON()` form, or an error name. */
export type PasskeyAnswer = { readonly error: string } | { readonly credential: Json };

const NOT_ALLOWED = { error: "NotAllowedError" } as const;
const TYPE_ERROR = { error: "TypeError" } as const;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const isBase64Url = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]*$/u.test(value);

const fromBase64Url = (value: string) => Buffer.from(value, "base64url");

const isPublicSuffix = (domain: string) =>
  getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;

/** The origin of a page that may use passkeys: https, or http on this machine. Null otherwise. */
export const passkeyOrigin = (url: string) => {
  if (!URL.canParse(url)) return null;
  const { protocol, hostname, origin } = new URL(url);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  return protocol === "https:" || (protocol === "http:" && loopback) ? origin : null;
};

/**
 * WebAuthn's rule: the RP ID is the page's host or a registrable parent of it,
 * and never a public suffix, so one github.io site cannot sign in for another.
 */
export const relyingPartyIdError = (origin: string, rpId: string) => {
  const host = new URL(origin).hostname;
  if (rpId === host) return host === "localhost" || !isPublicSuffix(host) ? null : "SecurityError";
  return !parse(host).isIp && host.endsWith(`.${rpId}`) && !isPublicSuffix(rpId)
    ? null
    : "SecurityError";
};

const credentialIds = (list: unknown) =>
  Array.isArray(list)
    ? list.flatMap((item) => {
        const descriptor = record(item);
        return descriptor?.type === "public-key" && isBase64Url(descriptor.id)
          ? [descriptor.id]
          : [];
      })
    : [];

/** Checks a page's options and settles what the viewer's device is asked for. */
export const passkeyRequest = (
  kind: "create" | "get",
  origin: string,
  options: unknown,
): PasskeyRequest | { readonly error: string } => {
  const publicKey = record(options);
  if (!publicKey || !isBase64Url(publicKey.challenge) || publicKey.challenge.length === 0) {
    return TYPE_ERROR;
  }
  const host = new URL(origin).hostname;
  const timeoutMs =
    typeof publicKey.timeout === "number" && Number.isFinite(publicKey.timeout)
      ? Math.min(Math.max(publicKey.timeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  if (kind === "get") {
    const rpId = publicKey.rpId ?? host;
    if (typeof rpId !== "string") return TYPE_ERROR;
    const rpError = relyingPartyIdError(origin, rpId);
    if (rpError) return { error: rpError };
    return {
      kind,
      origin,
      rpId,
      challenge: publicKey.challenge,
      publicKey: { ...publicKey, rpId },
      timeoutMs,
      allowCredentials: credentialIds(publicKey.allowCredentials),
      credProps: false,
    };
  }
  const rp = record(publicKey.rp);
  const user = record(publicKey.user);
  if (!rp || !user || typeof rp.name !== "string" || typeof user.name !== "string") {
    return TYPE_ERROR;
  }
  const userIdLength = isBase64Url(user.id) ? fromBase64Url(user.id).length : 0;
  if (userIdLength < 1 || userIdLength > 64) return TYPE_ERROR;
  const rpId = rp.id ?? host;
  if (typeof rpId !== "string") return TYPE_ERROR;
  const rpError = relyingPartyIdError(origin, rpId);
  if (rpError) return { error: rpError };
  const params = publicKey.pubKeyCredParams;
  if (params !== undefined && !Array.isArray(params)) return TYPE_ERROR;
  const allowsEs256 =
    !Array.isArray(params) ||
    params.length === 0 ||
    params.some((param) => record(param)?.alg === ES256);
  if (!allowsEs256) return { error: "NotSupportedError" };
  return {
    kind,
    origin,
    rpId,
    challenge: publicKey.challenge,
    publicKey: {
      ...publicKey,
      rp: { ...rp, id: rpId },
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
    },
    timeoutMs,
    allowCredentials: [],
    credProps: record(publicKey.extensions)?.credProps === true,
  };
};

/** Decodes the first CBOR item, in the definite-length subset authenticators emit. */
const decodeCbor = (bytes: Uint8Array): unknown => {
  let offset = 0;
  const malformed = () => new Error("Malformed CBOR");
  const item = (depth: number): unknown => {
    const initial = bytes[offset++];
    if (initial === undefined || depth > 16) throw malformed();
    const major = initial >> 5;
    const info = initial & 31;
    let length = info;
    if (info >= 24) {
      if (info > 27) throw malformed();
      const size = 1 << (info - 24);
      if (offset + size > bytes.length) throw malformed();
      length = 0;
      for (let index = 0; index < size; index++) length = length * 256 + (bytes[offset++] ?? 0);
    }
    switch (major) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2:
      case 3: {
        if (offset + length > bytes.length) throw malformed();
        const value = bytes.subarray(offset, offset + length);
        offset += length;
        return major === 2 ? value : new TextDecoder().decode(value);
      }
      case 4:
      case 5: {
        // Every member takes at least a byte, which also bounds hostile lengths.
        if (length > bytes.length - offset) throw malformed();
        if (major === 4) return Array.from({ length }, () => item(depth + 1));
        const map = new Map<unknown, unknown>();
        for (let index = 0; index < length; index++) map.set(item(depth + 1), item(depth + 1));
        return map;
      }
      case 6:
        return item(depth + 1);
      default:
        return info === 21 ? true : info === 20 ? false : null;
    }
  };
  try {
    return item(0);
  } catch {
    return undefined;
  }
};

// SubjectPublicKeyInfo header for an uncompressed P-256 point, the form Chromium's getPublicKey() returns.
const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
  "hex",
);

/** Reads the attested credential out of registration authenticator data. */
const attestedCredential = (authData: Uint8Array) => {
  // rpIdHash 32, flags 1, sign count 4, AAGUID 16, then a length-prefixed credential ID and its COSE key.
  if (authData.length < 55 || ((authData[32] ?? 0) & 0x40) === 0) return undefined;
  const idLength = ((authData[53] ?? 0) << 8) | (authData[54] ?? 0);
  const credentialId = authData.subarray(55, 55 + idLength);
  if (credentialId.length !== idLength) return undefined;
  const key = decodeCbor(authData.subarray(55 + idLength));
  const algorithm = key instanceof Map ? key.get(3) : undefined;
  if (!(key instanceof Map) || typeof algorithm !== "number") return undefined;
  const x = key.get(-2);
  const y = key.get(-3);
  const p256 =
    key.get(1) === 2 &&
    key.get(-1) === 1 &&
    x instanceof Uint8Array &&
    y instanceof Uint8Array &&
    x.length === 32 &&
    y.length === 32;
  return {
    credentialId: Buffer.from(credentialId).toString("base64url"),
    algorithm,
    publicKey: p256 ? Buffer.concat([P256_SPKI_PREFIX, x, y]).toString("base64url") : undefined,
  };
};

const parseJson = (text: string) => {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Turns the device's result into what the page receives. The device must have
 * signed this ceremony for this page: its client data names the page's origin
 * and challenge, and its authenticator data the RP ID's hash.
 */
export const passkeyAnswer = (request: PasskeyRequest, result: unknown): PasskeyAnswer => {
  const answer = record(result);
  if (answer?.success !== true) {
    const error = answer?.error;
    return typeof error === "string" && ERROR_NAMES.includes(error) ? { error } : NOT_ALLOWED;
  }
  const credential = record(answer.credential);
  if (
    !credential ||
    !isBase64Url(credential.id) ||
    credential.id.length === 0 ||
    !isBase64Url(credential.clientDataJSON)
  ) {
    return NOT_ALLOWED;
  }
  const clientData = parseJson(fromBase64Url(credential.clientDataJSON).toString("utf8"));
  if (
    clientData?.type !== (request.kind === "create" ? "webauthn.create" : "webauthn.get") ||
    clientData.origin !== request.origin ||
    clientData.challenge !== request.challenge
  ) {
    return NOT_ALLOWED;
  }
  const rpIdHash = NodeCrypto.createHash("sha256").update(request.rpId).digest();
  const authenticatorAttachment =
    credential.authenticatorAttachment === "platform" ||
    credential.authenticatorAttachment === "cross-platform"
      ? credential.authenticatorAttachment
      : null;

  if (request.kind === "create") {
    if (!isBase64Url(credential.attestationObject)) return NOT_ALLOWED;
    const attestation = decodeCbor(fromBase64Url(credential.attestationObject));
    const authData = attestation instanceof Map ? attestation.get("authData") : undefined;
    if (!(authData instanceof Uint8Array) || !rpIdHash.equals(authData.subarray(0, 32))) {
      return NOT_ALLOWED;
    }
    const attested = attestedCredential(authData);
    if (attested?.credentialId !== credential.id) return NOT_ALLOWED;
    return {
      credential: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        authenticatorAttachment,
        response: {
          clientDataJSON: credential.clientDataJSON,
          attestationObject: credential.attestationObject,
          authenticatorData: Buffer.from(authData).toString("base64url"),
          transports: Array.isArray(credential.transports)
            ? credential.transports.filter((transport) => typeof transport === "string")
            : [],
          publicKeyAlgorithm: attested.algorithm,
          ...(attested.publicKey === undefined ? {} : { publicKey: attested.publicKey }),
        },
        // Passkeys on Apple devices are always discoverable.
        clientExtensionResults:
          request.credProps && authenticatorAttachment === "platform"
            ? { credProps: { rk: true } }
            : {},
      },
    };
  }

  if (
    !isBase64Url(credential.authenticatorData) ||
    !isBase64Url(credential.signature) ||
    (credential.userHandle !== undefined && !isBase64Url(credential.userHandle))
  ) {
    return NOT_ALLOWED;
  }
  const authData = fromBase64Url(credential.authenticatorData);
  if (authData.length < 37 || !rpIdHash.equals(authData.subarray(0, 32))) return NOT_ALLOWED;
  // A security key can answer with a credential the page did not list.
  if (request.allowCredentials.length > 0 && !request.allowCredentials.includes(credential.id)) {
    return NOT_ALLOWED;
  }
  return {
    credential: {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      authenticatorAttachment,
      response: {
        clientDataJSON: credential.clientDataJSON,
        authenticatorData: credential.authenticatorData,
        signature: credential.signature,
        ...(credential.userHandle ? { userHandle: credential.userHandle } : {}),
      },
      clientExtensionResults: {},
    },
  };
};
