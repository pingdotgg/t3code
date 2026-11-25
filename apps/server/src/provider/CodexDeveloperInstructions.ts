import type { AgentFeedbackMode } from "@t3tools/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  buildT3OrchestrationSections,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
  readonly linkedEnvironments?: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean"
    ? { browser: availability, device: false, linkedEnvironments: false }
    : availability;

export interface CodexRuntimeInfo {
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly isGitRepository?: boolean | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = normalizeAvailability(toolsAvailable);
  const orchestrationSections = buildT3OrchestrationSections({
    browser: tools.browser,
    linkedEnvironments: tools.linkedEnvironments === true,
  });
  const runtimePolicy =
    runtime.isGitRepository === undefined
      ? undefined
      : { cwd: null, isGitRepository: runtime.isGitRepository };
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      orchestrationSections.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({
        harness: "Codex",
        ...runtime,
        ...(runtimePolicy === undefined ? {} : { runtimePolicy }),
      }),
    },
    ...(tools.device
      ? { t3_code_tools: { kind: "application", value: T3_CODE_DEVICE_TOOL_INSTRUCTIONS } }
      : {}),
  };
}
