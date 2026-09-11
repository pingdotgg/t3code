// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  getSubagentMessages,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentHistoryEntry, OrchestrationGetAgentHistoryResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { agentHistoryEntry, collectAgentHistory } from "./agentHistory.ts";

const isAgentId = Schema.is(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)));
const isSessionId = Schema.is(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)));

const decodeTranscriptEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
  { onExcessProperty: "preserve" },
);
const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.Boolean),
});
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
  }),
);
const decodeTextContent = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** Return an empty history response with a recoverable explanation for the client. */
const unavailable = (message: string): OrchestrationGetAgentHistoryResult => ({
  status: "unavailable",
  entries: [],
  nextOffset: null,
  message,
});

/** Missing transcript directories mean no saved history; other filesystem errors remain visible. */
async function directoryEntries(path: string) {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Use lstat so a symlink cannot redirect traversal outside the configured transcript store. */
async function isDirectory(path: string) {
  try {
    return (await NodeFSP.lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Find only regular child transcripts inside the persisted parent's directory. */
async function findTranscript(
  directory: string,
  filename: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 16) return null;
  const entries = await directoryEntries(directory);
  if (entries.some((entry) => entry.name === filename && entry.isFile()))
    return NodePath.join(directory, filename);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findTranscript(NodePath.join(directory, entry.name), filename, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Extract only textual tool results; image and other binary blocks are not activity text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = decodeTextContent(content);
  return blocks._tag === "Some"
    ? blocks.value.flatMap((block) => (block.text ? [block.text] : [])).join("\n")
    : "";
}

/** Skip unsupported transcript records while retaining the rest of the saved conversation. */
export function claudeHistoryEntries(message: SessionMessage): AgentHistoryEntry[] {
  const decoded = decodeMessage(message.message);
  if (decoded._tag === "None") return [];
  const { content } = decoded.value;
  if (typeof content === "string")
    return content
      ? [
          agentHistoryEntry(
            message.uuid,
            message.type === "user" ? "user" : "assistant",
            message.type === "user" ? "Prompt" : "Agent",
            content,
          ),
        ]
      : [];
  return content.flatMap((block, index): AgentHistoryEntry[] => {
    const id = `${message.uuid}:${index}`;
    switch (block.type) {
      case "text":
        return block.text
          ? [
              agentHistoryEntry(
                id,
                message.type === "user" ? "user" : "assistant",
                message.type === "user" ? "Prompt" : "Agent",
                block.text,
              ),
            ]
          : [];
      case "thinking":
        return block.thinking
          ? [agentHistoryEntry(id, "reasoning", "Reasoning", block.thinking)]
          : [];
      case "tool_use": {
        const fileEdit =
          block.name === "Edit" || block.name === "Write" || block.name === "MultiEdit";
        const path =
          block.input &&
          typeof block.input === "object" &&
          "file_path" in block.input &&
          typeof block.input.file_path === "string"
            ? block.input.file_path
            : null;
        return [
          agentHistoryEntry(
            id,
            fileEdit ? "file-edit" : "tool",
            fileEdit && path ? `Edit ${path}` : (block.name ?? "Tool"),
            JSON.stringify(block.input ?? {}, null, 2),
          ),
        ];
      }
      case "tool_result":
        return [
          agentHistoryEntry(
            id,
            "tool",
            block.is_error ? "Tool error" : "Tool result",
            resultText(block.content),
          ),
        ];
      default:
        return [];
    }
  });
}

/** The SDK rebuilds the conversation chain. A read-only store keeps its reads instance-local. */
export async function readClaudeAgentHistory(input: {
  configDir: string;
  sessionId: string;
  agentId: string;
  offset: number;
  view?: "recent-tools" | "latest" | undefined;
}): Promise<OrchestrationGetAgentHistoryResult> {
  if (!isAgentId(input.agentId) || !isSessionId(input.sessionId)) {
    return unavailable("No saved transcript is available for this agent.");
  }
  const projectsDir = NodePath.join(input.configDir, "projects");
  let transcript: string | null = null;
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = NodePath.join(projectsDir, project.name);
    const sessionDir = NodePath.join(projectDir, input.sessionId);
    if (
      !(await isDirectory(sessionDir)) ||
      !(await isDirectory(NodePath.join(sessionDir, "subagents")))
    )
      continue;
    transcript = await findTranscript(
      NodePath.join(sessionDir, "subagents"),
      `agent-${input.agentId}.jsonl`,
    );
    if (transcript) break;
  }
  if (!transcript)
    return unavailable("Claude has no saved transcript for this agent in this session.");
  const handle = await NodeFSP.open(
    transcript,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  let contents: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return unavailable("The agent transcript is not a regular file.");
    if (stat.size > 64 * 1024 * 1024)
      return unavailable("This agent transcript is too large to load.");
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const lines = contents.split("\n");
  const entries: SessionStoreEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      entries.push(decodeTranscriptEntry(line));
    } catch (error) {
      // A running Claude process may still be writing the last JSONL record.
      if (index === lines.length - 1 && !contents.endsWith("\n")) break;
      throw error;
    }
  }
  const messages = await getSubagentMessages(input.sessionId, input.agentId, {
    sessionStore: {
      append: async () => {
        throw new Error("Agent history is read-only.");
      },
      load: async () => entries,
    },
  });
  const page = collectAgentHistory(input);
  for (const message of messages) {
    for (const entry of claudeHistoryEntries(message)) {
      if (page.add(entry)) return page.result();
    }
  }
  return page.result();
}
