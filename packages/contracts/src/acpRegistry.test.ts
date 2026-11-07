import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ACP_REGISTRY_ICON_URL_MAX_LENGTH,
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  officialAcpRegistryIconUrlForAgentId,
  resolveAcpRegistryIconUrl,
  resolveOfficialAcpRegistryIconUrl,
} from "./acpRegistry.ts";

const decodeUninstallInput = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallInput);
const decodeUninstallResult = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallResult);

describe("ACP Registry contracts", () => {
  it("accepts only official Registry icon URLs and safe agent IDs", () => {
    expect(officialAcpRegistryIconUrlForAgentId("antigravity-acp")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../antigravity-acp")).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg");
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com.evil/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://user@cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
  });

  it("accepts small inline SVG and PNG icons alongside official Registry URLs", () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(resolveAcpRegistryIconUrl(svg)).toBe(svg);
    expect(resolveAcpRegistryIconUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(
      resolveAcpRegistryIconUrl("https://cdn.agentclientprotocol.com/registry/v1/latest/pi.svg"),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/pi.svg");
    expect(resolveAcpRegistryIconUrl("data:text/html;base64,PGgxPg==")).toBeNull();
    expect(resolveAcpRegistryIconUrl("data:image/svg+xml,<svg></svg>")).toBeNull();
    expect(resolveAcpRegistryIconUrl("https://example.com/icon.svg")).toBeNull();
    expect(
      resolveAcpRegistryIconUrl(
        `data:image/svg+xml;base64,${"A".repeat(ACP_REGISTRY_ICON_URL_MAX_LENGTH)}`,
      ),
    ).toBeNull();
  });

  it("decodes managed binary uninstall payloads and rejects unsafe agent IDs", () => {
    expect(decodeUninstallInput({ agentId: "  example-agent  " })).toEqual({
      agentId: "example-agent",
    });
    expect(decodeUninstallResult({ agentId: "example-agent", removed: false })).toEqual({
      agentId: "example-agent",
      removed: false,
    });
    expect(() => decodeUninstallInput({ agentId: "../example-agent" })).toThrow();
  });
});
