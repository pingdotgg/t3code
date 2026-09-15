import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  chooseLoadBalancedEnvironment,
  isLoadBalancingCandidate,
  isAutomaticPlatformRoutingBlocked,
  platformRoutingUnavailableReason,
} from "./load-balancing.ts";

const now = 100_000;
const resources = {
  sampledAt: now,
  cpuCount: 8,
  cpuUtilization: 0.2,
  totalMemoryBytes: 16_000,
  availableMemoryBytes: 8_000,
};
const mac = { environmentId: "mac", platformOs: "darwin" as const, resources, weight: 50 };
const linux = {
  ...mac,
  environmentId: "linux",
  platformOs: "linux" as const,
  resources: { ...resources, cpuCount: 32 },
};
const driver = ProviderDriverKind.make("codex");
const instance = ProviderInstanceId.make("codex-work");
const provider = {
  driver,
  instanceId: instance,
  enabled: true,
  installed: true,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  availability: "available" as const,
};
const environment = {
  connection: { phase: "connected" },
  serverConfig: { environment: { platform: { os: "darwin" as const } }, providers: [provider] },
};

describe("platform-constrained Auto balance", () => {
  it("keeps the current winner for Any and selects a lower-scoring Mac when required", () => {
    expect(chooseLoadBalancedEnvironment([mac, linux], now)).toBe("linux");
    expect(chooseLoadBalancedEnvironment([mac, linux], now, null)).toBe("linux");
    expect(chooseLoadBalancedEnvironment([mac, linux], now, "darwin")).toBe("mac");
    expect(chooseLoadBalancedEnvironment([mac, linux], now, "windows")).toBeNull();
  });
  it("still balances between multiple matching machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [mac, { ...mac, environmentId: "larger-mac", resources: linux.resources }, linux],
        now,
        "darwin",
      ),
    ).toBe("larger-mac");
  });
  it.each(["unknown", undefined] as const)("accepts %s OS only for Any", (platformOs) => {
    const candidate = { ...linux, ...(platformOs === undefined ? {} : { platformOs }) };
    if (platformOs === undefined) delete (candidate as { platformOs?: string }).platformOs;
    expect(chooseLoadBalancedEnvironment([candidate], now, null)).toBe("linux");
    expect(chooseLoadBalancedEnvironment([candidate], now, "linux")).toBeNull();
  });
  it.each([
    { weight: 0 },
    { resources: null },
    { resources: { ...resources, sampledAt: now - 15_001 } },
    { resources: { ...resources, sampledAt: now + 5_001 } },
    { resources: { ...resources, cpuUtilization: 0.95 } },
    { resources: { ...resources, cpuUtilization: null } },
    { resources: { ...resources, availableMemoryBytes: 800 } },
  ])("does not restore resource-ineligible matching machines: %j", (override) => {
    expect(
      chooseLoadBalancedEnvironment([{ ...mac, ...override }, linux], now, "darwin"),
    ).toBeNull();
  });
  it("uses WSL's Linux descriptor independently of its Windows host", () => {
    const windows = {
      ...linux,
      environmentId: "same-device-windows",
      platformOs: "windows" as const,
    };
    const wsl = { ...mac, environmentId: "same-device-wsl", platformOs: "linux" as const };
    expect(chooseLoadBalancedEnvironment([windows, wsl], now, "linux")).toBe(wsl.environmentId);
    expect(chooseLoadBalancedEnvironment([windows, wsl], now, "windows")).toBe(
      windows.environmentId,
    );
  });
  it("keeps connected, provider-instance and positive-weight requirements", () => {
    expect(isLoadBalancingCandidate(environment, 50, driver, instance, "darwin")).toBe(true);
    expect(isLoadBalancingCandidate(environment, 0, driver, instance, "darwin")).toBe(false);
    expect(
      isLoadBalancingCandidate(environment, 50, driver, ProviderInstanceId.make("other"), "darwin"),
    ).toBe(false);
    expect(
      isLoadBalancingCandidate(
        environment,
        50,
        ProviderDriverKind.make("claudeAgent"),
        null,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isLoadBalancingCandidate(
        { ...environment, connection: { phase: "disconnected" } },
        50,
        driver,
        instance,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isLoadBalancingCandidate(
        { ...environment, serverConfig: null },
        50,
        driver,
        instance,
        "darwin",
      ),
    ).toBe(false);
    expect(
      isLoadBalancingCandidate(
        { ...environment, serverConfig: { ...environment.serverConfig, providers: [] } },
        50,
        driver,
        instance,
        "darwin",
      ),
    ).toBe(false);
  });
  it.each([
    { enabled: false },
    { installed: false },
    { status: "error" as const },
    { auth: { status: "unauthenticated" as const } },
    { availability: "unavailable" as const },
  ])("does not restore failed providers: %j", (override) => {
    expect(
      isLoadBalancingCandidate(
        {
          ...environment,
          serverConfig: { ...environment.serverConfig, providers: [{ ...provider, ...override }] },
        },
        50,
        driver,
        instance,
        "darwin",
      ),
    ).toBe(false);
  });
  it("distinguishes platform/provider mismatch from unavailable resource capacity", () => {
    expect(platformRoutingUnavailableReason("darwin", false)).toContain(
      "No connected macOS environment is eligible",
    );
    expect(platformRoutingUnavailableReason("darwin", true)).toContain("resource capacity");
  });
  it("fails closed when a saved winner is missing, incompatible, or retargeted", () => {
    const input = {
      requiredPlatformOs: "darwin" as const,
      environmentSelection: "auto" as const,
      selectedEnvironmentId: "mac",
      currentEnvironmentId: "mac",
      eligibleEnvironmentIds: ["mac"],
    };
    expect(isAutomaticPlatformRoutingBlocked(input)).toBe(false);
    expect(isAutomaticPlatformRoutingBlocked({ ...input, eligibleEnvironmentIds: [] })).toBe(true);
    expect(isAutomaticPlatformRoutingBlocked({ ...input, eligibleEnvironmentIds: ["linux"] })).toBe(
      true,
    );
    expect(isAutomaticPlatformRoutingBlocked({ ...input, currentEnvironmentId: "linux" })).toBe(
      true,
    );
    expect(isAutomaticPlatformRoutingBlocked({ ...input, selectedEnvironmentId: null })).toBe(true);
    expect(
      isAutomaticPlatformRoutingBlocked({
        ...input,
        environmentSelection: "manual",
        currentEnvironmentId: "linux",
      }),
    ).toBe(false);
    expect(
      isAutomaticPlatformRoutingBlocked({
        ...input,
        requiredPlatformOs: null,
        eligibleEnvironmentIds: [],
      }),
    ).toBe(false);
  });
});
