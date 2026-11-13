/**
 * ACP agents T3 knows how to launch from a local executable. A preset only
 * fills in the local command fields; the agent itself still speaks ACP.
 */
export interface AcpLocalAgentPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly website: string;
  readonly keywords?: readonly string[];
}

export const ACP_LOCAL_AGENT_PRESETS: readonly AcpLocalAgentPreset[] = [
  {
    id: "oh-my-pi",
    name: "Oh My Pi",
    description: "Oh My Pi coding agent, launched as a local ACP command.",
    executable: "omp",
    args: ["acp"],
    website: "https://omp.sh/",
    keywords: ["pi", "omp"],
  },
];

export function matchAcpLocalAgentPresets(query: string): readonly AcpLocalAgentPreset[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return ACP_LOCAL_AGENT_PRESETS.filter((preset) =>
    [preset.id, preset.name, preset.executable, ...(preset.keywords ?? [])].some((term) =>
      term.toLowerCase().includes(needle),
    ),
  );
}

export function isConfiguredAcpLocalAgent(
  instances: Readonly<Record<string, { readonly driver: string; readonly config?: unknown }>>,
  preset: AcpLocalAgentPreset,
): boolean {
  return Object.values(instances).some((instance) => {
    if (
      instance.driver !== "acpRegistry" ||
      !instance.config ||
      typeof instance.config !== "object"
    ) {
      return false;
    }
    const config = instance.config as Record<string, unknown>;
    if (config.source !== "local") return false;
    const executable =
      typeof config.commandPath === "string" ? (config.commandPath.split(/[\\/]/).pop() ?? "") : "";
    const args = Array.isArray(config.commandArgs) ? config.commandArgs : [];
    return (
      executable === preset.executable &&
      args.length === preset.args.length &&
      args.every((argument, index) => argument === preset.args[index])
    );
  });
}
