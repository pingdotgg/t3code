import { describe, expect, it } from "vite-plus/test";

import { matchesLocalAgentCommand } from "./adapter.ts";

const KIMI = /^kimi(?:-code)?(\.exe|\.cmd)?$/i;
const COPILOT = /^(?:github-)?copilot(?:-cli)?(\.exe|\.cmd)?$/i;
const CLAUDE = /^claude(?:-agent)?-acp(\.exe|\.cmd)?$/i;

describe("matchesLocalAgentCommand", () => {
  it.each([
    ["kimi-code", true],
    ["kimi", true],
    ["kimi-code.exe", true],
    ["kimi.cmd", true],
    ["kimicode", false],
  ])("local command %s enables Kimi handling: %s", (command, expected) => {
    expect(matchesLocalAgentCommand(`/usr/local/bin/${command}`, "local", KIMI)).toBe(expected);
  });

  it.each([
    ["copilot", true],
    ["github-copilot-cli.exe", true],
    ["copilot-cli.CMD", true],
    ["copilotx", false],
  ])("local command %s enables Copilot handling: %s", (command, expected) => {
    expect(matchesLocalAgentCommand(`C:\\Tools\\${command}`, "local", COPILOT)).toBe(expected);
  });

  it.each([
    ["claude-acp", true],
    ["claude-agent-acp.exe", true],
    ["claude", false],
  ])("local command %s enables Claude handling: %s", (command, expected) => {
    expect(matchesLocalAgentCommand(`/opt/bin/${command}`, "local", CLAUDE)).toBe(expected);
  });

  it("never matches non-local sources", () => {
    expect(matchesLocalAgentCommand("/usr/bin/kimi-code", "registry", KIMI)).toBe(false);
    expect(matchesLocalAgentCommand("/usr/bin/kimi-code", "npx", KIMI)).toBe(false);
  });
});
