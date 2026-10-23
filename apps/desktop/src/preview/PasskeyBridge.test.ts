import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";

import { PASSKEY_CREATE_CHANNEL, PASSKEY_GET_CHANNEL } from "./GuestProtocol.ts";
import { installPasskeyBridge } from "./PasskeyBridge.ts";

const base64Url = (bytes: ReadonlyArray<number>) => Buffer.from(bytes).toString("base64url");
const bytesOf = (buffer: ArrayBuffer | null) => (buffer ? [...new Uint8Array(buffer)] : null);

const assertionData = {
  credentialId: base64Url([1, 2, 3]),
  clientDataJSON: base64Url([4]),
  authenticatorData: base64Url([5]),
  signature: base64Url([6, 7]),
  userHandle: base64Url([8]),
  extensions: { prf: { results: { first: base64Url([9]) } } },
};

const creationOptions: PublicKeyCredentialCreationOptions = {
  challenge: new Uint8Array([1]),
  rp: { name: "Example" },
  user: { id: new Uint8Array([2]), name: "alice", displayName: "Alice" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

const illegalInvocation = (): never => {
  throw new TypeError("Illegal invocation");
};

/**
 * Installs the bridge over fresh stand-ins for the page's DOM classes. Like
 * Chromium's, their getters only work on objects the browser created itself.
 */
const install = (respond: (channel: string) => unknown) => {
  const nativeCreate = vi.fn(async () => "native-create");
  const nativeGet = vi.fn(async () => "native-get");
  class FakeCredentialsContainer {
    create() {
      return nativeCreate();
    }
    get() {
      return nativeGet();
    }
  }
  class FakePublicKeyCredential {
    get id() {
      return illegalInvocation();
    }
    get response() {
      return illegalInvocation();
    }
  }
  class FakeAttestationResponse {
    get clientDataJSON() {
      return illegalInvocation();
    }
  }
  class FakeAssertionResponse {
    get signature() {
      return illegalInvocation();
    }
  }
  vi.stubGlobal("CredentialsContainer", FakeCredentialsContainer);
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse);
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse);

  const invoke = vi.fn(async (channel: string, _publicKey: unknown) => respond(channel));
  installPasskeyBridge(invoke);
  return {
    invoke,
    nativeCreate,
    nativeGet,
    credentials: new FakeCredentialsContainer() as unknown as CredentialsContainer,
    FakePublicKeyCredential,
    FakeAttestationResponse,
    FakeAssertionResponse,
  };
};

describe("installPasskeyBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves passkey sign-in through the main process with a credential pages can verify", async () => {
    const { invoke, credentials, FakePublicKeyCredential, FakeAssertionResponse } = install(() => ({
      success: true,
      data: assertionData,
    }));
    const challenge = new Uint8Array([0, 1, 2, 3]).subarray(1);

    const credential = (await credentials.get({
      publicKey: {
        challenge,
        rpId: "example.com",
        allowCredentials: [{ type: "public-key", id: new Uint8Array([1, 2, 3]) }],
        extensions: { onHint: () => {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;

    assert.deepStrictEqual(invoke.mock.calls[0], [
      PASSKEY_GET_CHANNEL,
      {
        challenge: new Uint8Array([1, 2, 3]),
        rpId: "example.com",
        allowCredentials: [{ type: "public-key", id: new Uint8Array([1, 2, 3]) }],
        extensions: {},
      },
    ]);
    const response = credential.response as AuthenticatorAssertionResponse;
    assert.instanceOf(credential, FakePublicKeyCredential);
    assert.instanceOf(response, FakeAssertionResponse);
    assert.strictEqual(credential.id, assertionData.credentialId);
    assert.deepStrictEqual(bytesOf(credential.rawId), [1, 2, 3]);
    assert.deepStrictEqual(bytesOf(response.signature), [6, 7]);
    assert.deepStrictEqual(bytesOf(response.userHandle), [8]);
    assert.deepStrictEqual(
      bytesOf(credential.getClientExtensionResults().prf?.results?.first as ArrayBuffer),
      [9],
    );
    assert.deepStrictEqual(credential.toJSON(), {
      id: assertionData.credentialId,
      rawId: assertionData.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: assertionData.clientDataJSON,
        authenticatorData: assertionData.authenticatorData,
        signature: assertionData.signature,
        userHandle: assertionData.userHandle,
      },
      clientExtensionResults: { prf: { results: { first: base64Url([9]) } } },
    });
  });

  it("rejects with the WebAuthn error the ceremony ended with", async () => {
    const { credentials } = install((channel) => ({
      success: false,
      error: channel === PASSKEY_CREATE_CHANNEL ? "InvalidStateError" : "TypeError",
    }));
    const created = await credentials
      .create({ publicKey: creationOptions })
      .catch((error: unknown) => error);
    assert.instanceOf(created, DOMException);
    assert.strictEqual((created as DOMException).name, "InvalidStateError");
    const fetched = await credentials
      .get({ publicKey: { challenge: new Uint8Array([1]) } })
      .catch((error: unknown) => error);
    assert.instanceOf(fetched, TypeError);
  });

  it("rejects as soon as the page aborts, without waiting on the system sheet", async () => {
    const { credentials } = install(() => new Promise(() => {}));
    const controller = new AbortController();

    const pending = credentials
      .get({ publicKey: { challenge: new Uint8Array([1]) }, signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();

    const error = await pending;
    assert.instanceOf(error, DOMException);
    assert.strictEqual((error as DOMException).name, "AbortError");
  });
});
