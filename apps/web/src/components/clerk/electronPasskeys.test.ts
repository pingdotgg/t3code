import { createPasskeys } from "@clerk/electron/passkeys";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const publicKeyOptions = {
  allowCredentials: [],
  challenge: new Uint8Array([1]),
  rpId: "clerk.t3.codes",
  timeout: 60_000,
  userVerification: "preferred" as const,
};

const stubNativePasskeys = () => {
  const get = vi.fn().mockResolvedValue({
    ok: false,
    error: { code: "cancelled", message: "user cancelled" },
  });

  vi.stubGlobal("location", { protocol: "t3code:", hostname: "app" });
  vi.stubGlobal("window", {
    PublicKeyCredential: vi.fn(),
    __clerk_internal_electron_passkeys: {
      platform: "darwin",
      electronMajor: 41,
      get,
    },
  });

  return get;
};

describe("Electron passkeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send an autofill request to the native bridge", async () => {
    const get = stubNativePasskeys();
    const passkeys = createPasskeys();

    const result = await passkeys.get({
      publicKeyOptions,
      conditionalUI: true,
    });

    expect(get).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ code: "passkey_operation_aborted" });
  });

  it("sends an explicit passkey request to the native bridge", async () => {
    const get = stubNativePasskeys();
    const passkeys = createPasskeys();

    await passkeys.get({
      publicKeyOptions,
      conditionalUI: false,
    });

    expect(get).toHaveBeenCalledOnce();
  });
});
