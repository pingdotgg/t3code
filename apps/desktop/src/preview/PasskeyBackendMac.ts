import { getPublicSuffix } from "tldts";

import type { PasskeyBackend, PasskeyCeremonyContext } from "./PasskeyBackend.ts";
import { authenticatorDataFromAttestation } from "./PasskeyAttestation.ts";
import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

const ES256 = -7;

// WebAuthn rejects RP IDs that are public suffixes, private registries
// included, so one github.io site cannot mint passkeys for every other one.
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

/**
 * macOS passkeys through AuthenticationServices (`electron-webauthn`): the
 * system sheet offers iCloud Keychain, password managers, phones, and security
 * keys. Needs Apple's managed browser entitlement in the signed build.
 */
export const macPasskeyBackend: PasskeyBackend = {
  create: async (publicKey, context): Promise<PasskeyCeremonyResult> => {
    // The native layer only converts P-256 keys and never settles for any
    // other algorithm, so ES256 is the only one it may negotiate.
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
    // The native layer reports parsed authenticator data as JSON and claims
    // every credential is a synced platform passkey; neither is reliable.
    const authData = authenticatorDataFromAttestation(
      Buffer.from(result.data.attestationObject, "base64url"),
    );
    // Sites verify the new credential from its authenticator data; without it
    // the passkey is unusable, so say so now rather than let sign-up fail later.
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
    // The native layer applies the site's allow list to platform passkeys only,
    // so a security key can answer with a credential the site did not ask for.
    const allowed = (Array.isArray(publicKey.allowCredentials) ? publicKey.allowCredentials : [])
      .filter((credential) => credential?.type === "public-key" && isBufferSource(credential.id))
      .map((credential) => toBase64Url(credential.id));
    if (allowed.length > 0 && !allowed.includes(result.data.credentialId)) {
      return { success: false, error: "NotAllowedError" };
    }
    return result;
  },
};
