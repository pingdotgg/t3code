import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMcpGate } from "./mcpGate";

const environment = {
  capabilities: { mcpApprovalCodes: true },
} as unknown as ServerConfig["environment"];

const config = (directEndpoints: ReadonlyArray<{ kind: "lan" | "tailnet"; httpBaseUrl: string }>) =>
  ({ environment, directEndpoints }) as const;

describe("resolveMcpGate", () => {
  it.each([
    {
      name: "the tailnet HTTPS name",
      endpoints: [
        { kind: "lan", httpBaseUrl: "http://192.168.1.4:3773" },
        { kind: "tailnet", httpBaseUrl: "http://100.64.0.2:3773" },
        { kind: "tailnet", httpBaseUrl: "https://studio.tail1234.ts.net" },
      ],
      gate: { kind: "open", mcpUrl: "https://studio.tail1234.ts.net/mcp" },
    },
    {
      name: "no tailnet HTTPS name",
      endpoints: [
        { kind: "lan", httpBaseUrl: "https://192.168.1.4:3773" },
        { kind: "tailnet", httpBaseUrl: "http://100.64.0.2:3773" },
      ],
      gate: { kind: "no-tailnet-https" },
    },
  ] as const)("opens only on $name", ({ endpoints, gate }) => {
    expect(resolveMcpGate({ connected: true, serverConfig: config(endpoints) })).toEqual(gate);
  });

  it("waits for the connection and the config, and asks old servers to update", () => {
    const serverConfig = config([{ kind: "tailnet", httpBaseUrl: "https://studio.ts.net" }]);
    expect(resolveMcpGate({ connected: false, serverConfig })).toEqual({ kind: "disconnected" });
    expect(resolveMcpGate({ connected: true, serverConfig: undefined })).toEqual({
      kind: "checking",
    });
    expect(
      resolveMcpGate({
        connected: true,
        serverConfig: {
          ...serverConfig,
          environment: { ...environment, capabilities: {} } as ServerConfig["environment"],
        },
      }),
    ).toEqual({ kind: "update" });
  });
});
