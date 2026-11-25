import type { AgentFeedbackMode } from "@lathe/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import {
  buildRuntimeInstructions,
  type ThreadHistoryInstructionMode,
} from "@lathe/provider-core/server/runtimeInstructions";

import {
  LATHE_BROWSER_TOOL_INSTRUCTIONS,
  LATHE_DEVICE_TOOL_INSTRUCTIONS,
  LATHE_ORCHESTRATION_SECTIONS,
} from "@lathe/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface LatheToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | LatheToolAvailability,
): LatheToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | LatheToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? LATHE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? LATHE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Set only when the session has the thread history tools attached. */
  readonly threadHistory?: ThreadHistoryInstructionMode | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | LatheToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      LATHE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `lathe_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    lathe_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { lathe_tools: { kind: "application", value: tools } } : {}),
  };
}
