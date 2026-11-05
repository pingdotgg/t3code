import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export const finalizedToolStatuses = ["completed", "failed", "cancelled", "interrupted"] as const;
export const summaryToolTypes = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "proposed_plan",
  "subagent",
  "error",
] as const;

/** Only user-visible evidence; reasoning, credentials and approval payloads are not sources. */
export function summaryToolText(item: OrchestrationV2TurnItem): string | null {
  if (!finalizedToolStatuses.some((status) => status === item.status)) return null;
  const evidence = (() => {
    switch (item.type) {
      case "command_execution":
        if (item.outputOmitted) return null;
        return { input: item.input, output: item.output, exitCode: item.exitCode };
      case "dynamic_tool":
        if (item.outputOmitted) return null;
        return { toolName: item.toolName, input: item.input, output: item.output };
      case "file_change":
        return {
          fileName: item.fileName,
          additions: item.additions,
          deletions: item.deletions,
          diff: item.diffStr,
          old: item.oldStr,
          new: item.newStr,
          changes: item.changes,
        };
      case "file_search":
        return { pattern: item.pattern, results: item.results };
      case "web_search":
        return { patterns: item.patterns, results: item.results };
      case "proposed_plan":
        return item.streaming ? null : { markdown: item.markdown };
      case "subagent":
        if (item.promptOmitted || item.resultOmitted) return null;
        return { prompt: item.prompt, result: item.result };
      case "error":
        return { failure: item.failure };
      default:
        return null;
    }
  })();
  return evidence === null
    ? null
    : JSON.stringify({ type: item.type, status: item.status, ...evidence }, null, 2);
}
