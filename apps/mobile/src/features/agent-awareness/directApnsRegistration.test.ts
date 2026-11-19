import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  environmentIds: [] as string[],
  catalogListeners: [] as Array<() => void>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));
vi.mock("@t3tools/client-runtime/state/connections", () => ({
  enabledEnvironmentIds: () => mocks.environmentIds,
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: Symbol("catalog") },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => ({}),
    subscribe: (_atom: unknown, listener: () => void) => {
      mocks.catalogListeners.push(listener);
      return () => undefined;
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { registerPushDevice: { label: "register" } },
}));

import {
  __resetDirectApnsRegistrationForTest,
  registerDirectApnsDevice,
  toPushDeviceRegistration,
} from "./directApnsRegistration";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

const request = (
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest => ({
  deviceId: "device-1",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  bundleId: "com.example.t3code",
  apsEnvironment: "sandbox",
  pushToken: "ab".repeat(32),
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: false,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  ...overrides,
});

beforeEach(() => {
  mocks.runAtomCommand.mockReset();
  mocks.runAtomCommand.mockResolvedValue({ _tag: "Success" });
  mocks.environmentIds = [ENV_A, ENV_B];
  mocks.catalogListeners.length = 0;
  __resetDirectApnsRegistrationForTest();
});

describe("toPushDeviceRegistration", () => {
  it("maps the relay registration onto the direct push registration", () => {
    expect(toPushDeviceRegistration(request())).toEqual({
      deviceId: "device-1",
      apnsToken: "ab".repeat(32),
      apsEnvironment: "sandbox",
      bundleId: "com.example.t3code",
      platform: "ios",
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: false,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    });
  });

  it("has nothing to register without a token, bundle ID or APNs environment, or on Android", () => {
    const { pushToken: _token, ...withoutToken } = request();
    expect(toPushDeviceRegistration(withoutToken)).toBeNull();
    const { bundleId: _bundle, ...withoutBundle } = request();
    expect(toPushDeviceRegistration(withoutBundle)).toBeNull();
    const { apsEnvironment: _env, ...withoutEnvironment } = request();
    expect(toPushDeviceRegistration(withoutEnvironment)).toBeNull();
    expect(
      toPushDeviceRegistration(
        request({
          platform: "android",
          androidApiLevel: 35,
        } as Partial<RelayDeviceRegistrationRequest>),
      ),
    ).toBeNull();
  });
});

describe("registerDirectApnsDevice", () => {
  it("registers with every connected environment", async () => {
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand.mock.calls.map(([, , target]) => target.environmentId)).toEqual([
      ENV_A,
      ENV_B,
    ]);
    expect(mocks.runAtomCommand.mock.calls[0]?.[2].input.apnsToken).toBe("ab".repeat(32));
  });

  it("skips environments that already hold this exact registration, and resends on change", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    await registerDirectApnsDevice(request({ pushToken: "cd".repeat(32) }));
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("retries an environment whose registration failed and never throws", async () => {
    mocks.environmentIds = [ENV_A];
    mocks.runAtomCommand.mockResolvedValueOnce({ _tag: "Failure" });
    await expect(registerDirectApnsDevice(request())).resolves.toBeUndefined();
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("registers environments that connect after the token was registered", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    mocks.environmentIds = [ENV_A, ENV_B];
    mocks.catalogListeners[0]?.();
    await vi.waitFor(() => expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2));
    expect(mocks.runAtomCommand.mock.calls[1]?.[2].environmentId).toBe(ENV_B);
    // A later registration does not stack a second catalog subscription.
    await registerDirectApnsDevice(request({ pushToken: "cd".repeat(32) }));
    expect(mocks.catalogListeners).toHaveLength(1);
  });
});
