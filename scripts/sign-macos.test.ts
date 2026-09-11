import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { afterEach, expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("batches codesign calls without changing existing signing options", async () => {
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "Developer ID Application: T3 Tools, Inc.",
    keychain: "/tmp/t3code.keychain",
    provisioningProfile: "/tmp/t3code.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/t3code.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it("gives credential-free fork builds a stable top-level update requirement", async () => {
  vi.stubEnv("T3CODE_MACOS_STABLE_ADHOC_BUNDLE_ID", "com.t3tools.t3code.fork-466f726b");
  const options = {
    app: "/tmp/T3 Code (Fork Nightly).app",
    optionsForFile: () => ({ hardenedRuntime: true }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    identity: "-",
    identityValidation: false,
    batchCodesignCalls: true,
    optionsForFile: expect.any(Function),
  });
  const signedOptions = vi.mocked(signApplication).mock.calls[0]?.[0];
  const optionsForFile = signedOptions?.optionsForFile;
  expect(
    optionsForFile?.("/tmp/T3 Code (Fork Nightly).app/Contents/MacOS/helper", {
      platform: "darwin",
    }),
  ).toEqual({ hardenedRuntime: true, timestamp: "none" });
  expect(optionsForFile?.(options.app, { platform: "darwin" })).toEqual({
    hardenedRuntime: true,
    timestamp: "none",
    requirements: '=designated => identifier "com.t3tools.t3code.fork-466f726b"',
  });
});

it("rejects an unsafe stable ad hoc bundle identifier", async () => {
  vi.stubEnv("T3CODE_MACOS_STABLE_ADHOC_BUNDLE_ID", 'bad" requirement');

  await expect(sign({ app: "/tmp/T3 Code.app" })).rejects.toThrow(
    "T3CODE_MACOS_STABLE_ADHOC_BUNDLE_ID must be a bundle identifier.",
  );
  expect(signApplication).not.toHaveBeenCalled();
});
