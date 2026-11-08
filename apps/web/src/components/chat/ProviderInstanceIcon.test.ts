import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isOfficialCommandCodeIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("Command Code official logo", () => {
  it("identifies Command Code usage and configured ACP agents without changing other providers", () => {
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("command-code"),
        displayName: "Command Code",
      }),
    ).toBe(true);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        displayName: "Command Code (Omarchy)",
        agentId: "command-code-omarchy",
      }),
    ).toBe(true);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        displayName: "Command Code",
        agentId: "command-code",
      }),
    ).toBe(true);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        displayName: "Unrelated Agent",
        agentId: "other-agent",
      }),
    ).toBe(false);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        displayName: "Command Code",
        agentId: "other-agent",
      }),
    ).toBe(false);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        displayName: "Command Code",
      }),
    ).toBe(true);
    expect(
      isOfficialCommandCodeIcon({
        driverKind: ProviderDriverKind.make("opencode"),
        displayName: "Command Code",
      }),
    ).toBe(false);
  });
});

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});
