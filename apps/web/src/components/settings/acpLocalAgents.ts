import type { ProviderIcon } from "@t3tools/provider-core/client";

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
  readonly icon?: ProviderIcon;
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
    icon: {
      viewBox: "0 0 64 64",
      fill: { light: "#0F0A14", dark: "#0F0A14" },
      paths: [
        {
          d: "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z",
          gradient: {
            x1: 0,
            y1: 0,
            x2: 64,
            y2: 64,
            stops: [
              { offset: 0, color: "#ed4abf" },
              { offset: 0.5, color: "#9b4dff" },
              { offset: 1, color: "#5ad8e6" },
            ],
          },
        },
      ],
    },
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

/** Windows command paths carry a `.exe` suffix the preset omits. */
function launchedExecutableName(commandPath: string): string {
  return (commandPath.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
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
      typeof config.commandPath === "string" ? launchedExecutableName(config.commandPath) : "";
    const args = Array.isArray(config.commandArgs) ? config.commandArgs : [];
    return (
      executable === preset.executable.toLowerCase() &&
      args.length === preset.args.length &&
      args.every((argument, index) => argument === preset.args[index])
    );
  });
}
