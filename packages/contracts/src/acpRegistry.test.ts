import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  localAcpProviderIconUrl,
  officialAcpRegistryIconUrlForAgentId,
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

  it("recognizes only a local Oh My Pi ACP command", () => {
    expect(
      localAcpProviderIconUrl({ source: "local", commandPath: "omp", commandArgs: ["acp"] }),
    ).toBe("https://omp.sh/favicon.svg");
    expect(
      localAcpProviderIconUrl({
        source: "local",
        commandPath: "/opt/oh-my-pi/omp.exe",
        commandArgs: ["acp", "--verbose"],
      }),
    ).toBe("https://omp.sh/favicon.svg");
    expect(
      localAcpProviderIconUrl({
        source: "local",
        commandPath: "C:\\tools\\omp.cmd",
        commandArgs: ["acp"],
      }),
    ).toBe("https://omp.sh/favicon.svg");
    expect(
      localAcpProviderIconUrl({ source: "local", commandPath: "omp", commandArgs: [] }),
    ).toBeNull();
    expect(
      localAcpProviderIconUrl({ source: "local", commandPath: "pi", commandArgs: ["acp"] }),
    ).toBeNull();
    expect(localAcpProviderIconUrl({ source: "registry", agentId: "pi-acp" })).toBeNull();
    expect(localAcpProviderIconUrl(null)).toBeNull();
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
