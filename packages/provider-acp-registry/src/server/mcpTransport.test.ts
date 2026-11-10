import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { prefersHttpMcpTransport } from "./mcpTransport.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("prefersHttpMcpTransport", () => {
  it("uses HTTP for the vendored Command Code launcher", () => {
    expect(
      prefersHttpMcpTransport(
        decodeSettings({
          source: "local",
          commandPath: "C:\\Users\\me\\.t3\\bin\\cmdcode\\node.exe",
          commandArgs: [
            "C:\\Users\\me\\.t3\\bin\\cmdcode\\node_modules\\command-code\\dist\\index.mjs",
            "acp",
          ],
        }),
      ),
    ).toBe(true);
  });

  it("uses HTTP for the global Command Code shim", () => {
    expect(
      prefersHttpMcpTransport(
        decodeSettings({
          source: "local",
          commandPath: "C:\\tools\\cmdc.cmd",
          commandArgs: ["acp"],
        }),
      ),
    ).toBe(true);
    expect(
      prefersHttpMcpTransport(
        decodeSettings({ source: "local", commandPath: "/usr/local/bin/cmdc" }),
      ),
    ).toBe(true);
  });

  it("keeps the stdio bridge for other local agents", () => {
    expect(
      prefersHttpMcpTransport(
        decodeSettings({
          source: "local",
          commandPath: "C:\\tools\\node.exe",
          commandArgs: ["C:\\tools\\some-other-agent\\dist\\index.mjs", "acp"],
        }),
      ),
    ).toBe(false);
    expect(
      prefersHttpMcpTransport(
        decodeSettings({ source: "local", commandPath: "C:\\tools\\claude-agent-acp.exe" }),
      ),
    ).toBe(false);
  });

  it("keeps the stdio bridge for registry agents", () => {
    expect(
      prefersHttpMcpTransport(decodeSettings({ source: "registry", agentId: "claude-acp" })),
    ).toBe(false);
  });
});
