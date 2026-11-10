// Agents the official ACP Registry does not publish. They use the same install
// and sign-in path as registry entries, and are skipped when an official id appears.
export const SUPPLEMENTAL_ACP_AGENT_RECORDS = [
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    version: "0.2.2-rc.1",
    description:
      "DeepSeek Harness CLI. T3 runs an installed dsh with --profile acp, and installs @deepseek-ai/dsh only when dsh is not already on PATH. Credentials stay in the dsh profile.",
    authors: ["DeepSeek"],
    license: "MIT",
    website: "https://github.com/deepseek-ai/deepseek-harness",
    repository: "https://github.com/deepseek-ai/deepseek-harness",
    distribution: {
      npx: {
        package: "@deepseek-ai/dsh@0.2.2-rc.1",
        args: ["--profile", "acp"],
      },
    },
  },
  {
    id: "zcode-acp",
    name: "ZCode",
    version: "0.3.2",
    description:
      "Unofficial ACP bridge for ZCode desktop 3.11.2. Other desktop versions are rejected. T3 downloads zcode-acp and starts it.",
    authors: ["supermomonga"],
    website: "https://github.com/supermomonga/zcode-acp",
    repository: "https://github.com/supermomonga/zcode-acp",
    distribution: {
      binary: {
        "darwin-aarch64": {
          archive:
            "https://github.com/supermomonga/zcode-acp/releases/download/v0.3.2/zcode-acp-darwin-arm64",
          cmd: "zcode-acp",
          sha256: "34d129c47bf5d50d3c00a55bbd16563d530f6edf0bbe7ee78a70da9ba1075fb3",
        },
        "darwin-x86_64": {
          archive:
            "https://github.com/supermomonga/zcode-acp/releases/download/v0.3.2/zcode-acp-darwin-x64",
          cmd: "zcode-acp",
          sha256: "b8bd83e9ad86117f4fbd488463fa5569f9577352377150c83e9596d935ee6504",
        },
        "linux-aarch64": {
          archive:
            "https://github.com/supermomonga/zcode-acp/releases/download/v0.3.2/zcode-acp-linux-arm64",
          cmd: "zcode-acp",
          sha256: "b8cdfffe55e922eebb6a295faa9db301cdc2e9e93d3dd38c0648514b8f33a16b",
        },
        "linux-x86_64": {
          archive:
            "https://github.com/supermomonga/zcode-acp/releases/download/v0.3.2/zcode-acp-linux-x64",
          cmd: "zcode-acp",
          sha256: "7c9c09b2961be81ae36bd700de097d4f06d91409d4178b6220e123768bffe4dd",
        },
        "windows-x86_64": {
          archive:
            "https://github.com/supermomonga/zcode-acp/releases/download/v0.3.2/zcode-acp-windows-x64.exe",
          cmd: "zcode-acp.exe",
          sha256: "2b88b1815544687a8b7e212255ae9e306307556dd590512f12eb40ef96cab225",
        },
      },
    },
  },
] as const;

/** Prefer this PATH command over a fresh install. Absent for agents that must be downloaded. */
export function supplementalPathCommand(agentId: string): string | undefined {
  return agentId === "deepseek-harness" ? "dsh" : undefined;
}

export function appendMissingAgents<Agent extends { readonly id: string }>(
  agents: ReadonlyArray<Agent>,
  extra: ReadonlyArray<Agent>,
): ReadonlyArray<Agent> {
  const present = new Set(agents.map((agent) => agent.id));
  const missing = extra.filter((agent) => !present.has(agent.id));
  return missing.length === 0 ? agents : [...agents, ...missing];
}
