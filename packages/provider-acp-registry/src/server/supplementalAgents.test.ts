import { describe, expect, it } from "@effect/vitest";

import { supplementalAcpAgents } from "./AcpRegistrySupport.ts";
import { appendMissingAgents, supplementalPathCommand } from "./supplementalAgents.ts";

describe("supplemental ACP agents", () => {
  it("registers DeepSeek Harness and the ZCode bridge", () => {
    expect(supplementalAcpAgents.map((agent) => agent.id)).toEqual([
      "deepseek-harness",
      "zcode-acp",
    ]);
    expect(supplementalAcpAgents[0]?.distribution.npx).toMatchObject({
      package: "@deepseek-ai/dsh@0.2.2-rc.1",
      args: ["--profile", "acp"],
    });
    expect(supplementalAcpAgents[1]?.distribution.binary?.["windows-x86_64"]?.cmd).toBe(
      "zcode-acp.exe",
    );
  });

  it("uses an installed dsh before downloading DeepSeek Harness", () => {
    expect(supplementalPathCommand("deepseek-harness")).toBe("dsh");
    expect(supplementalPathCommand("zcode-acp")).toBeUndefined();
  });

  it("keeps an official entry when the same id is already published", () => {
    const official = { id: "deepseek-harness", name: "Official" };
    expect(appendMissingAgents([official], [{ id: "deepseek-harness", name: "Local" }])).toEqual([
      official,
    ]);
    expect(appendMissingAgents([], [{ id: "zcode-acp", name: "ZCode" }])).toEqual([
      { id: "zcode-acp", name: "ZCode" },
    ]);
  });
});
