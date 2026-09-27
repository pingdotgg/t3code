import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { installPasskeyShim, type PreviewPasskeyBridge } from "./PasskeyShim.ts";

function page() {
  const request = vi.fn<PreviewPasskeyBridge["request"]>();
  const cancel = vi.fn();
  const get = vi.fn(() => Promise.resolve(null));
  const create = vi.fn(() => Promise.resolve(null));
  // Real credential interfaces need prototypes even when the fixture has no instance methods.
  // oxlint-disable-next-line typescript/no-extraneous-class
  class Credential {
    static isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
    static isConditionalMediationAvailable = async () => true;
    static getClientCapabilities = async () => ({ conditionalGet: true, conditionalCreate: true });
  }
  const window = {
    isSecureContext: true,
    PublicKeyCredential: Credential,
    __t3PreviewPasskeys: { available: async () => true, request, cancel },
  };
  Object.assign(window, { top: window });
  const navigator = { credentials: { get, create } };
  NodeVM.runInNewContext(`(${installPasskeyShim.toString()})()`, {
    window,
    navigator,
    PublicKeyCredential: Credential,
    // oxlint-disable-next-line typescript/no-extraneous-class
    AuthenticatorAssertionResponse: class {},
    // oxlint-disable-next-line typescript/no-extraneous-class
    AuthenticatorAttestationResponse: class {},
    crypto,
    btoa,
    atob,
    Uint8Array,
    ArrayBuffer,
    DOMException,
    structuredClone,
  });
  return {
    request,
    cancel,
    navigator: navigator as unknown as Navigator,
    originalGet: get,
    Credential,
  };
}

describe("preview passkey page API", () => {
  it("round-trips binary assertions and exposes standard credential methods", async () => {
    const h = page();
    h.request.mockResolvedValue({
      id: "AQID",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: "BAUG",
        authenticatorData: "BwgJ",
        signature: "CgsM",
        userHandle: "",
      },
    });
    const backing = new Uint8Array([0, 1, 2, 3, 0]);
    const result = (await h.navigator.credentials.get({
      publicKey: { challenge: backing.subarray(1, 4) },
    })) as PublicKeyCredential;
    expect(h.request.mock.calls[0]?.[2]).toEqual({ challenge: "AQID" });
    expect(result).toBeInstanceOf(h.Credential);
    expect(new Uint8Array(result.rawId)).toEqual(new Uint8Array([1, 2, 3]));
    expect((result.response as AuthenticatorAssertionResponse).userHandle).toBeNull();
    expect(result.toJSON().response).not.toHaveProperty("userHandle");
    expect(result.toJSON()).toMatchObject({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { signature: "CgsM" },
    });
  });
  it("never opens a native prompt for autofill and preserves non-passkey credentials", async () => {
    const h = page();
    await h.navigator.credentials.get({
      publicKey: { challenge: new Uint8Array([1]) },
      mediation: "conditional",
    });
    await h.navigator.credentials.get({});
    expect(h.originalGet).toHaveBeenCalledTimes(2);
    expect(h.request).not.toHaveBeenCalled();
    expect(await h.Credential.isConditionalMediationAvailable()).toBe(false);
    expect(await h.Credential.getClientCapabilities()).toMatchObject({
      conditionalGet: false,
      conditionalCreate: false,
      userVerifyingPlatformAuthenticator: true,
    });
  });
  it("keeps silent authentication on Chromium without a native prompt", async () => {
    const h = page();
    const options = { publicKey: { challenge: new Uint8Array([1]) }, mediation: "silent" as const };
    expect(await h.navigator.credentials.get(options)).toBeNull();
    expect(h.originalGet).toHaveBeenCalledWith(options);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("returns sorted registration transports through both WebAuthn accessors", async () => {
    const h = page();
    h.request.mockResolvedValue({
      id: "AQID",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: "BAUG",
        attestationObject: "BwgJ",
        authenticatorData: "CgsM",
        publicKey: "DQ4P",
        publicKeyAlgorithm: -7,
      },
    });
    const credential = (await h.navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array([1]),
        rp: { name: "Example" },
        user: { id: new Uint8Array([2]), name: "Alice", displayName: "Alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
    })) as PublicKeyCredential;
    expect((credential.response as AuthenticatorAttestationResponse).getTransports()).toEqual([
      "hybrid",
      "internal",
    ]);
    expect(credential.toJSON().response).toMatchObject({ transports: ["hybrid", "internal"] });
  });
  it("rejects an aborted request immediately and cancels the native sheet", async () => {
    const h = page();
    h.request.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController();
    const result = h.navigator.credentials.get({
      publicKey: { challenge: new Uint8Array([1]) },
      signal: abort.signal,
    });
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(h.cancel).toHaveBeenCalledWith(h.request.mock.calls[0]?.[0]);
  });
  it("returns to Chromium only when the native provider is unavailable", async () => {
    const h = page();
    h.request.mockResolvedValueOnce(null).mockResolvedValueOnce({ error: "NotAllowedError" });
    const options = { publicKey: { challenge: new Uint8Array([1]) } };
    await h.navigator.credentials.get(options);
    expect(h.originalGet).toHaveBeenCalledOnce();
    await expect(h.navigator.credentials.get(options)).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(h.originalGet).toHaveBeenCalledOnce();
  });
});
