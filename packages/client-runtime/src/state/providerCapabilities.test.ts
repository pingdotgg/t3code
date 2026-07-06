import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { buildProviderProjectCapabilitiesQueryTarget } from "./providerCapabilities.ts";

const environmentId = EnvironmentId.make("environment-a");
const providerInstanceId = ProviderInstanceId.make("codex");

function provider(
  overrides: Partial<Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "availability">>,
): Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "availability"> {
  return {
    instanceId: providerInstanceId,
    enabled: true,
    installed: true,
    ...overrides,
  };
}

describe("buildProviderProjectCapabilitiesQueryTarget", () => {
  it("builds a query for enabled available providers and preserves exact cwd", () => {
    const cwd = "/repo/with-space ";

    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd,
        providers: [provider({})],
      }),
    ).toEqual({
      environmentId,
      input: {
        providerInstanceId,
        cwd,
      },
    });
  });

  it("does not query disabled, uninstalled, unavailable, missing, or blank targets", () => {
    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd: "/repo",
        providers: [provider({ enabled: false })],
      }),
    ).toBeNull();
    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd: "/repo",
        providers: [provider({ installed: false })],
      }),
    ).toBeNull();
    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd: "/repo",
        providers: [provider({ availability: "unavailable" })],
      }),
    ).toBeNull();
    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd: "/repo",
        providers: [],
      }),
    ).toBeNull();
    expect(
      buildProviderProjectCapabilitiesQueryTarget({
        environmentId,
        providerInstanceId,
        cwd: "   ",
        providers: [provider({})],
      }),
    ).toBeNull();
  });
});
