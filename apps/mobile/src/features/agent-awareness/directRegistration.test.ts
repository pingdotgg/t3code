import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type DirectPushStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{
    environmentId: string;
    request: {
      action: string;
      registration?: {
        activityToken: string | null;
        liveActivitiesEnabled: boolean;
        apsEnvironment: string;
        appScheme: string;
      };
    };
  }>,
  instances: new Map<
    string,
    Array<{
      getId: () => string;
      getPushToken: () => Promise<string | null>;
      addPushTokenListener: (listener: (event: { pushToken: string }) => void) => {
        remove: () => void;
      };
      update: () => Promise<void>;
      end: () => Promise<void>;
    }>
  >(),
  tokenListeners: new Map<string, (event: { pushToken: string }) => void>(),
  activeCount: 1,
  failStart: false,
  starts: [] as string[],
  pushEnvironment: "development" as "development" | "production" | null,
  releaseType: 3,
  readReleaseType: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  createRuntimeCommand: () => ({
    run: (_registry: unknown, input: (typeof mocks.requests)[number]) =>
      Effect.sync(() => {
        mocks.requests.push(input);
        return input.request.action === "unregister"
          ? null
          : ({
              configured: true,
              bundleId: "test.app",
              registered: input.request.action === "register",
              activity: {
                title: "Agent activity",
                subtitle: "Working",
                activeCount: mocks.activeCount,
                updatedAt: "2026-09-06T12:00:00Z",
                activities: [],
              },
            } satisfies DirectPushStatus);
      }),
  }),
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({ requestDirectPush: vi.fn() }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: async () => "phone",
}));
vi.mock("../../widgets/pseudocode/WorkLiveActivity", () => ({ WorkLiveActivity: "layout" }));
vi.mock("./registrationPayload", () => ({ resolveApsEnvironment: () => "production" }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { ios: { bundleIdentifier: "test.app" }, extra: {} } },
}));
vi.mock("expo-linking", () => ({ createURL: () => "t3code-dev:///" }));
vi.mock("expo-application", () => ({
  applicationId: "test.app",
  ApplicationReleaseType: { UNKNOWN: 0, SIMULATOR: 1, DEVELOPMENT: 3, APP_STORE: 5 },
  getIosPushNotificationServiceEnvironmentAsync: async () => mocks.pushEnvironment,
  getIosApplicationReleaseTypeAsync: async () => {
    mocks.readReleaseType();
    return mocks.releaseType;
  },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: true }),
  getDevicePushTokenAsync: async () => ({ data: "aabb" }),
}));
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("expo-widgets", () => ({
  createLiveActivity: (name: string) => ({
    getInstances: () => mocks.instances.get(name) ?? [],
    start: () => {
      if (mocks.failStart) throw new Error("Activities disabled in iOS");
      mocks.starts.push(name);
      const activity = {
        getId: () => `${name}-id`,
        getPushToken: async () => "ccdd",
        addPushTokenListener: (listener: (event: { pushToken: string }) => void) => {
          mocks.tokenListeners.set(name, listener);
          return { remove: () => mocks.tokenListeners.delete(name) };
        },
        update: async () => {},
        end: async () => {
          mocks.instances.delete(name);
        },
      };
      mocks.instances.set(name, [activity]);
      return activity;
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.requests.length = 0;
  mocks.starts.length = 0;
  mocks.instances.clear();
  mocks.tokenListeners.clear();
  mocks.activeCount = 1;
  mocks.failStart = false;
  mocks.pushEnvironment = "development";
  mocks.releaseType = 3;
  mocks.readReleaseType.mockClear();
});

it("creates one card per environment and registers its ActivityKit token", async () => {
  const { syncDirectPush } = await import("./directRegistration");
  const first = EnvironmentId.make("first");
  const second = EnvironmentId.make("second");
  await syncDirectPush(first, true);
  await syncDirectPush(first, true);
  await syncDirectPush(second, true);
  expect(mocks.starts).toEqual(["DirectAgentActivity:first", "DirectAgentActivity:second"]);
  expect(
    mocks.requests.find((item) => item.request.action === "register")?.request.registration
      ?.apsEnvironment,
  ).toBe("sandbox");
  expect(
    mocks.requests.find((item) => item.request.action === "register")?.request.registration
      ?.appScheme,
  ).toBe("t3code-dev");
  expect(mocks.readReleaseType).not.toHaveBeenCalled();
  expect(
    mocks.requests
      .filter((item) => item.request.action === "register")
      .every((item) => item.request.registration?.activityToken === "ccdd"),
  ).toBe(true);
});

it("registers Apple-distributed installs without an embedded profile and starts their card", async () => {
  mocks.pushEnvironment = null;
  mocks.releaseType = 5;
  const { syncDirectPush } = await import("./directRegistration");
  await syncDirectPush(EnvironmentId.make("testflight"), true);
  const registration = mocks.requests.find((item) => item.request.action === "register");
  expect(registration?.request.registration?.apsEnvironment).toBe("production");
  expect(registration?.request.registration?.activityToken).toBe("ccdd");
  expect(mocks.starts).toEqual(["DirectAgentActivity:testflight"]);
});

it.each([1, 0, 3])(
  "does not guess a push environment for non-store release type %s",
  async (releaseType) => {
    mocks.pushEnvironment = null;
    mocks.releaseType = releaseType;
    const { syncDirectPush } = await import("./directRegistration");
    await expect(syncDirectPush(EnvironmentId.make("unknown"), true)).rejects.toThrow(
      releaseType === 1 ? "physical iPhone" : "push provisioning profile",
    );
    expect(mocks.starts).toEqual([]);
    expect(mocks.requests.some((item) => item.request.action === "register")).toBe(false);
  },
);

it("ends existing cards and removes server registration when disabled", async () => {
  const { syncDirectPush, disableDirectPush } = await import("./directRegistration");
  const id = EnvironmentId.make("first");
  await syncDirectPush(id, true);
  await disableDirectPush(id);
  expect(mocks.instances.size).toBe(0);
  expect(mocks.tokenListeners.size).toBe(0);
  expect(mocks.requests.at(-1)?.request.action).toBe("unregister");
});

it("registers notifications without making an empty or disabled Live Activity", async () => {
  const { syncDirectPush } = await import("./directRegistration");
  mocks.activeCount = 0;
  await syncDirectPush(EnvironmentId.make("idle"), true);
  mocks.activeCount = 1;
  await syncDirectPush(EnvironmentId.make("disabled"), false);
  expect(mocks.starts).toEqual([]);
  expect(mocks.requests.filter((item) => item.request.action === "register")).toHaveLength(2);
});

it("keeps alert registration working when iOS refuses a Live Activity", async () => {
  const { syncDirectPush } = await import("./directRegistration");
  mocks.failStart = true;
  await expect(syncDirectPush(EnvironmentId.make("first"), true)).rejects.toThrow(
    "Notifications registered",
  );
  expect(mocks.requests.at(-1)?.request.action).toBe("register");
});

it("ignores repeated native push-token events", async () => {
  const { rememberDirectPushToken } = await import("./directRegistration");
  expect(rememberDirectPushToken({ type: "ios", data: "aabb" })).toBe(true);
  expect(rememberDirectPushToken({ type: "ios", data: "aabb" })).toBe(false);
  expect(rememberDirectPushToken({ type: "ios", data: "bbcc" })).toBe(true);
});

it("describes Apple's answer to the last push", async () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-24T12:03:00Z"));
  const { describeDirectPushDelivery } = await import("./directRegistration");
  const at = "2026-10-24T12:00:00Z";
  expect(describeDirectPushDelivery({ at, kind: "alert", status: 200, reason: null })).toBe(
    "Last push: delivered 3m ago",
  );
  expect(
    describeDirectPushDelivery({
      at,
      kind: "liveactivity",
      status: 403,
      reason: "BadEnvironmentKeyInToken",
    }),
  ).toBe("Last push: rejected by Apple (BadEnvironmentKeyInToken)");
  expect(describeDirectPushDelivery({ at, kind: "background", status: 410, reason: null })).toBe(
    "Last push: rejected by Apple (HTTP 410)",
  );
  expect(
    describeDirectPushDelivery({ at, kind: "alert", status: null, reason: "socket hang up" }),
  ).toBe("Last push: no answer from Apple (socket hang up)");
});
