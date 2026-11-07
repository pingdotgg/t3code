import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  platform: "android",
  protected: false,
  switcherProtected: false,
  ready: Promise.resolve(),
  failSwitcher: false,
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));
vi.mock("expo-screen-capture", () => ({
  preventScreenCaptureAsync: async () => {
    await native.ready;
    if (native.protected) throw new Error("Native protection is not reentrant");
    native.protected = true;
  },
  allowScreenCaptureAsync: async () => {
    native.protected = false;
  },
  enableAppSwitcherProtectionAsync: async () => {
    if (native.failSwitcher) throw new Error("Unavailable");
    native.switcherProtected = true;
  },
  disableAppSwitcherProtectionAsync: async () => {
    native.switcherProtected = false;
  },
}));

async function setup(platform: string) {
  vi.resetModules();
  native.platform = platform;
  native.protected = false;
  native.switcherProtected = false;
  native.ready = Promise.resolve();
  native.failSwitcher = false;
  return import("./secretDeliveryPrivacy");
}

it.each(["android", "ios"])(
  "keeps %s protection until the last card releases, including a replacement",
  async (platform) => {
    const { acquireSecretDeliveryPrivacy } = await setup(platform);
    const [first, second] = await Promise.all([
      acquireSecretDeliveryPrivacy(),
      acquireSecretDeliveryPrivacy(),
    ]);
    expect(native.protected).toBe(true);
    expect(native.switcherProtected).toBe(platform === "ios");
    await first();
    await first();
    expect(native.protected).toBe(true);
    const releasing = second();
    const replacement = acquireSecretDeliveryPrivacy();
    await releasing;
    const releaseReplacement = await replacement;
    expect(native.protected).toBe(true);
    await releaseReplacement();
    expect(native.protected).toBe(false);
    expect(native.switcherProtected).toBe(false);
  },
);

it("does not grant a lease before native readiness and can release a late acquisition", async () => {
  const { acquireSecretDeliveryPrivacy } = await setup("android");
  const ready = Promise.withResolvers<void>();
  native.ready = ready.promise;
  let granted = false;
  const acquisition = acquireSecretDeliveryPrivacy().then((release) => {
    granted = true;
    return release;
  });
  expect(granted).toBe(false);
  expect(native.protected).toBe(false);
  ready.resolve();
  const release = await acquisition;
  expect(granted).toBe(true);
  expect(native.protected).toBe(true);
  await release();
  expect(native.protected).toBe(false);
});

it("rolls back partial iOS protection on failure and permits a later acquisition", async () => {
  const { acquireSecretDeliveryPrivacy } = await setup("ios");
  native.failSwitcher = true;
  await expect(acquireSecretDeliveryPrivacy()).rejects.toThrow("Unavailable");
  expect(native.protected).toBe(false);
  native.failSwitcher = false;
  const release = await acquireSecretDeliveryPrivacy();
  expect(native.switcherProtected).toBe(true);
  await release();
  expect(native.protected).toBe(false);
});
