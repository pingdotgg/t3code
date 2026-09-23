import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  os: "android",
  version: 36,
  openSettings: vi.fn(),
  native: null as {
    configure?: ReturnType<typeof vi.fn>;
    clear?: ReturnType<typeof vi.fn>;
    openLiveUpdateSettings?: ReturnType<typeof vi.fn>;
  } | null,
  config: { scheme: ["t3code-preview"], extra: { iosPersonalTeamBuild: false } },
  requireModule: vi.fn(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: mocks.requireModule }));
vi.mock("expo-constants", () => ({ default: { expoConfig: mocks.config } }));
vi.mock("react-native", () => ({
  Linking: { openSettings: mocks.openSettings },
  Platform: {
    get Version() {
      return mocks.version;
    },
    get OS() {
      return mocks.os;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.os = "android";
  mocks.version = 36;
  mocks.openSettings.mockReset().mockResolvedValue(undefined);
  mocks.native = { configure: vi.fn(), clear: vi.fn() };
  mocks.config.extra.iosPersonalTeamBuild = false;
  mocks.requireModule.mockReset().mockImplementation(() => mocks.native);
});

describe("Android native notification capability", () => {
  it("opens the Live Update controls on supported Android builds", async () => {
    mocks.native!.openLiveUpdateSettings = vi.fn(() => true);
    const { openAndroidLiveUpdateSettings, supportsAndroidLiveUpdateSettings } =
      await import("./androidNotifications");
    expect(supportsAndroidLiveUpdateSettings()).toBe(true);
    await openAndroidLiveUpdateSettings();
    expect(mocks.native!.openLiveUpdateSettings).toHaveBeenCalledOnce();
    expect(mocks.openSettings).not.toHaveBeenCalled();
    mocks.version = 35;
    expect(supportsAndroidLiveUpdateSettings()).toBe(false);
    mocks.os = "ios";
    mocks.version = 36;
    expect(supportsAndroidLiveUpdateSettings()).toBe(false);
  });

  it.each([undefined, vi.fn(() => false)])(
    "falls back to app settings for older binaries or missing system activities (%j)",
    async (openLiveUpdateSettings) => {
      if (openLiveUpdateSettings) mocks.native!.openLiveUpdateSettings = openLiveUpdateSettings;
      const { openAndroidLiveUpdateSettings } = await import("./androidNotifications");
      await openAndroidLiveUpdateSettings();
      expect(mocks.openSettings).toHaveBeenCalledOnce();
    },
  );

  it("uses the installed module and the build variant's deep-link scheme", async () => {
    const { configureAndroidAgentNotifications, clearAndroidAgentNotifications } =
      await import("./androidNotifications");
    const { supportsAgentAwarenessPush } = await import("./capabilities");
    // An iOS-only signing restriction must not disable Android notifications.
    mocks.config.extra.iosPersonalTeamBuild = true;
    expect(supportsAgentAwarenessPush()).toBe(true);
    configureAndroidAgentNotifications("device", "user", false);
    expect(mocks.native?.configure).toHaveBeenCalledWith("device", "user", "t3code-preview", false);
    clearAndroidAgentNotifications();
    expect(mocks.native?.clear).toHaveBeenCalledOnce();
  });

  it.each([null, { clear: vi.fn() }, { configure: vi.fn() }])(
    "disables push when the native binary is missing required methods (%j)",
    async (native) => {
      mocks.native = native;
      const { configureAndroidAgentNotifications, clearAndroidAgentNotifications } =
        await import("./androidNotifications");
      const { supportsAgentAwarenessPush } = await import("./capabilities");
      expect(supportsAgentAwarenessPush()).toBe(false);
      expect(() => configureAndroidAgentNotifications("device", "user", true)).not.toThrow();
      expect(() => clearAndroidAgentNotifications()).not.toThrow();
    },
  );

  it("preserves the iOS personal-team restriction without loading Android code", async () => {
    mocks.os = "ios";
    const { supportsAgentAwarenessPush } = await import("./capabilities");
    expect(supportsAgentAwarenessPush()).toBe(true);
    mocks.config.extra.iosPersonalTeamBuild = true;
    expect(supportsAgentAwarenessPush()).toBe(false);
    expect(mocks.requireModule).not.toHaveBeenCalled();
  });
});
