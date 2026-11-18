import { field } from "../unknownField.ts";

export type ClaudeSessionLogEntry =
  | {
      readonly kind: "context";
      readonly label: string;
      readonly role: string;
      readonly text: string;
      readonly timestamp: string | undefined;
    }
  | {
      readonly kind: "systemPrompt";
      readonly blocks: ReadonlyArray<string>;
      readonly text: string;
      readonly timestamp: string | undefined;
    };

const LABELS: Readonly<Record<string, string>> = {
  skill_listing: "skill list",
  mcp_instructions_delta: "MCP server instructions",
  deferred_tools_delta: "tool list",
  agent_listing_delta: "agent list",
  environment: "environment",
  session_context: "session context",
  date: "date",
  model: "model",
};

function label(type: string, attachment: unknown): string {
  const hookName = field(attachment, "hookName");
  if (type.startsWith("hook_") && typeof hookName === "string") return `hook ${hookName}`;
  const files = field(attachment, "files");
  if (type === "instructions") {
    return Array.isArray(files) ? `instruction files (${files.length})` : "instruction files";
  }
  return LABELS[type] ?? type;
}

/**
 * Reads what Claude Code added to the model's input from lines of its session log: every
 * attachment record sent as text, and each system prompt snapshot. The format is internal to the
 * CLI, so unknown record types pass through under their raw name and malformed lines are skipped.
 * `attachmentRecords` counts all attachment records, sent as text or not.
 */
export function parseClaudeSessionLogContext(lines: Iterable<string>): {
  readonly entries: ReadonlyArray<ClaudeSessionLogEntry>;
  readonly attachmentRecords: number;
} {
  const entries: Array<ClaudeSessionLogEntry> = [];
  let attachmentRecords = 0;
  for (const line of lines) {
    // Logs reach many megabytes; only attachment records are worth parsing.
    if (!line.includes('"attachment"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (field(record, "type") !== "attachment") continue;
    attachmentRecords += 1;
    const attachment = field(record, "attachment");
    const rawType = field(attachment, "type");
    const type = typeof rawType === "string" ? rawType : "unknown";
    const rawTimestamp = field(record, "timestamp");
    const timestamp = typeof rawTimestamp === "string" ? rawTimestamp : undefined;
    if (type === "prompt_snapshot") {
      const systemPrompt = field(attachment, "systemPrompt");
      const blocks = Array.isArray(systemPrompt)
        ? systemPrompt.filter((block) => typeof block === "string")
        : [];
      if (blocks.length > 0) {
        entries.push({ kind: "systemPrompt", blocks, text: blocks.join("\n\n"), timestamp });
      }
      continue;
    }
    const rendered = field(record, "rendered");
    const text = (Array.isArray(rendered) ? rendered : [])
      .map((part) => field(part, "content"))
      .filter((content) => typeof content === "string")
      .join("\n\n");
    if (text === "") continue;
    const role = field(record, "renderedRole");
    entries.push({
      kind: "context",
      label: label(type, attachment),
      role: typeof role === "string" ? role : "unknown",
      text,
      timestamp,
    });
  }
  return { entries, attachmentRecords };
}
