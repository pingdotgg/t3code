import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_COMPUTER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

/**
 * Apps may store up to 16 KiB each and a thread can hold any number of them,
 * so only the most recently updated ones that fit this budget go to Codex.
 */
export const CODEX_APP_CONTEXT_MAX_TOTAL_BYTES = 4 * CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;

const TRUNCATION_MARKER = "\n…[truncated]…\n";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const takeUtf8Bytes = (chars: ReadonlyArray<string>, maxBytes: number): Array<string> => {
  const taken: Array<string> = [];
  let bytes = 0;
  for (const char of chars) {
    bytes += utf8Bytes(char);
    if (bytes > maxBytes) break;
    taken.push(char);
  }
  return taken;
};

/**
 * Cuts the middle out ourselves, as Codex would, so a value restored after
 * compaction (which Codex does not truncate) matches what the turn delivered.
 */
const fitCodexContextValue = (text: string): string => {
  if (utf8Bytes(text) <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) return text;
  const chars = Array.from(text);
  const half = Math.floor(
    (CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES - utf8Bytes(TRUNCATION_MARKER)) / 2,
  );
  const head = takeUtf8Bytes(chars, half).join("");
  const tail = takeUtf8Bytes(chars.toReversed(), half).toReversed().join("");
  return `${head}${TRUNCATION_MARKER}${tail}`;
};

/**
 * An app's context is text an MCP server wrote, so it goes in as untrusted
 * context: Codex renders it as quoted user-side input, never as developer
 * instructions. Entries arrive oldest update first.
 */
export function buildCodexAppContext(
  entries: ReadonlyArray<{ readonly key: string; readonly text: string }>,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const kept: Array<readonly [string, V2TurnStartParams__AdditionalContextEntry]> = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    const value = fitCodexContextValue(entry.text);
    bytes += utf8Bytes(value);
    if (bytes > CODEX_APP_CONTEXT_MAX_TOTAL_BYTES) break;
    kept.push([entry.key, { kind: "untrusted", value }]);
  }
  return Object.fromEntries(kept.toReversed());
}

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
  readonly computer?: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean"
    ? { browser: availability, device: false, computer: false }
    : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
    tools.computer ? T3_CODE_COMPUTER_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      // Effort changes already travel as turn settings; repeating them here busts the prompt cache.
      value: buildRuntimeInstructions({
        harness: "Codex",
        model: runtime.model,
        modelName: runtime.modelName,
      }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
