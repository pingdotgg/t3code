import { getPublicSuffix } from "tldts";

import type { PasskeyBackend, PasskeyCeremonyContext } from "./PasskeyBackend.ts";
import { authenticatorDataFromAttestation } from "./PasskeyAttestation.ts";
import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

const ES256 = -7;

// WebAuthn rejects public suffix RP IDs, including private registries such as github.io.
const isPublicSuffix = (domain: string) =>
  domain !== "localhost" && getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;

// Loaded only once a ceremony runs: the module and its native addon ship on macOS alone.
const nativeOptions = async (context: PasskeyCeremonyContext) => ({
  webauthn: await import("electron-webauthn"),
  options: {
    currentOrigin: context.origin,
    topFrameOrigin: context.origin,
    nativeWindowHandle: context.nativeWindowHandle,
    isPublicSuffix,
  },
});

const isBufferSource = (value: unknown): value is BufferSource =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

const toBase64Url = (value: BufferSource) =>
  Buffer.from(
    ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value),
  ).toString("base64url");

/** Requires Apple's managed browser entitlement in the signed build. */
export const macPasskeyBackend: PasskeyBackend = {
  create: async (publicKey, context): Promise<PasskeyCeremonyResult> => {
    // The native layer only converts P-256 keys, so negotiate only ES256.
    const params: unknown = publicKey.pubKeyCredParams;
    if (params !== undefined && !Array.isArray(params))
      return { success: false, error: "TypeError" };
    const allowsEs256 =
      params === undefined ||
      params.length === 0 ||
      params.some(
        (param: unknown) =>
          typeof param === "object" && param !== null && "alg" in param && param.alg === ES256,
      );
    if (!allowsEs256) return { success: false, error: "NotSupportedError" };
    const { webauthn, options } = await nativeOptions(context);
    const result = await webauthn.createCredential(
      { ...publicKey, pubKeyCredParams: [{ type: "public-key", alg: ES256 }] },
      options,
    );
    if (!result.success) return { success: false, error: result.error };
    // Native parsed authenticator JSON and synced-platform-passkey claims are unreliable.
    const authData = authenticatorDataFromAttestation(
      Buffer.from(result.data.attestationObject, "base64url"),
    );
    if (!authData) return { success: false, error: "NotAllowedError" };
    return {
      success: true,
      data: {
        ...result.data,
        authData: Buffer.from(authData).toString("base64url"),
        transports: [],
      },
    };
  },
  get: async (publicKey, context): Promise<PasskeyCeremonyResult> => {
    const { webauthn, options } = await nativeOptions(context);
    // WebAuthn defaults the RP ID to the caller's host; the native layer requires it.
    const result = await webauthn.getCredential(
      { ...publicKey, rpId: publicKey.rpId ?? new URL(context.origin).hostname },
      options,
    );
    if (!result.success) return { success: false, error: result.error };
    // Native allow lists cover only platform passkeys; security-key responses need checking here.
    const allowed = (Array.isArray(publicKey.allowCredentials) ? publicKey.allowCredentials : [])
      .filter((credential) => credential?.type === "public-key" && isBufferSource(credential.id))
      .map((credential) => toBase64Url(credential.id));
    if (allowed.length > 0 && !allowed.includes(result.data.credentialId)) {
      return { success: false, error: "NotAllowedError" };
    }
    return result;
  },
};
