/**
 * GlmAdapterLive - HTTP-based live implementation for the GLM (z.ai) provider adapter.
 *
 * Implements an agent loop via GLM's OpenAI-compatible chat completions API
 * with SSE streaming and local tool execution.
 *
 * @module GlmAdapterLive
 */
import {
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import { GlmAdapter, type GlmAdapterShape } from "../Services/GlmAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "glm" as const;
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const MAX_AGENT_LOOP_ITERATIONS = 32;
const MAX_SUB_AGENT_ITERATIONS = 16;
const MAX_SUB_AGENT_DEPTH = 3;

// ── Types ─────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface GlmSession {
  threadId: ThreadId;
  model: string;
  cwd: string;
  messages: ChatMessage[];
  activeTurnAbort: AbortController | null;
  pendingApproval: {
    resolve: (decision: string) => void;
    requestId: string;
  } | null;
  status: "ready" | "running" | "stopped";
  createdAt: string;
  updatedAt: string;
  runtimeMode: "full-access" | "approval-required";
}

// ── Tool definitions ──────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path to read." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file, creating it if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write to." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Edit a file by replacing old_text with new_text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          old_text: { type: "string", description: "Text to find and replace." },
          new_text: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description: "Execute a shell command and return the output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          cwd: { type: "string", description: "Working directory (optional, defaults to session cwd)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files and directories in a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_files",
      description: "Search for a pattern in files using grep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)." },
          path: { type: "string", description: "Directory to search in (optional)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "spawn_agent",
      description:
        "Spawn a sub-agent to handle a complex, self-contained task autonomously. " +
        "The sub-agent gets its own conversation with the same tools and works independently. " +
        "Use this to parallelize work or delegate tasks like: researching a codebase question, " +
        "implementing a well-scoped feature, running and fixing tests, or refactoring a module. " +
        "The sub-agent returns its final result as text.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "A detailed description of the task for the sub-agent. Be specific about what to do, " +
              "which files to look at, and what the expected outcome is.",
          },
          name: {
            type: "string",
            description:
              "A short, descriptive name for this sub-agent (e.g. 'test-runner', 'file-analyzer', 'docs-writer'). " +
              "This is shown to the user to identify what the agent is doing.",
          },
          cwd: {
            type: "string",
            description: "Working directory for the sub-agent (optional, defaults to parent session cwd).",
          },
        },
        required: ["task"],
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────

let eventCounter = 0;
function nextEventId(): string {
  return `glm-evt-${Date.now()}-${++eventCounter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventBase(
  threadId: ThreadId,
  turnId?: TurnId,
  itemId?: string,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const base: Record<string, unknown> = {
    eventId: EventId.makeUnsafe(nextEventId()),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
  };
  if (turnId) base.turnId = turnId;
  if (itemId) base.itemId = RuntimeItemId.makeUnsafe(itemId);
  return base as Omit<ProviderRuntimeEvent, "type" | "payload">;
}

function toolCallToCanonicalItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return "file_change";
    case "run_command":
      return "command_execution";
    case "list_directory":
    case "search_files":
      return "file_change";
    case "spawn_agent":
      return "collab_agent_tool_call";
    default:
      return "unknown";
  }
}

function resolveApiKey(): string | undefined {
  return process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY;
}

function resolveBaseUrl(overrideUrl?: string): string {
  return overrideUrl ?? process.env.GLM_BASE_URL ?? DEFAULT_BASE_URL;
}

// ── Tool execution ────────────────────────────────────────────────

async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const { execSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

  switch (toolName) {
    case "read_file": {
      const filePath = resolvePath(String(args.path ?? ""));
      return fs.readFileSync(filePath, "utf-8");
    }
    case "write_file": {
      const filePath = resolvePath(String(args.path ?? ""));
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, String(args.content ?? ""), "utf-8");
      return `File written: ${filePath}`;
    }
    case "edit_file": {
      const filePath = resolvePath(String(args.path ?? ""));
      const existing = fs.readFileSync(filePath, "utf-8");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!existing.includes(oldText)) {
        return `Error: old_text not found in ${filePath}`;
      }
      fs.writeFileSync(filePath, existing.replace(oldText, newText), "utf-8");
      return `File edited: ${filePath}`;
    }
    case "run_command": {
      const command = String(args.command ?? "");
      const cmdCwd = args.cwd ? resolvePath(String(args.cwd)) : cwd;
      const result = execSync(command, {
        cwd: cmdCwd,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return String(result);
    }
    case "list_directory": {
      const dirPath = resolvePath(String(args.path ?? "."));
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n");
    }
    case "search_files": {
      const pattern = String(args.pattern ?? "");
      const searchPath = args.path ? resolvePath(String(args.path)) : cwd;
      const result = execSync(`grep -rn --include='*' ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} || true`, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });
      return typeof result === "string" ? result.slice(0, 10_000) : "";
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── Sub-agent runner ──────────────────────────────────────────────

interface SubAgentProgressContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly parentItemId: string;
  readonly agentName: string;
  readonly emit: (event: ProviderRuntimeEvent) => void;
}

function emitSubAgentProgress(
  ctx: SubAgentProgressContext,
  detail: string,
  depth: number,
) {
  const label = ctx.agentName || (depth > 0 ? `sub-agent-L${depth}` : "sub-agent");
  ctx.emit({
    ...makeEventBase(ctx.threadId, ctx.turnId, ctx.parentItemId),
    type: "item.updated",
    payload: {
      itemType: "collab_agent_tool_call" as CanonicalItemType,
      status: "inProgress",
      title: "spawn_agent",
      detail: `[${label}] ${detail}`.slice(0, 180),
      data: { agentName: ctx.agentName, depth },
    },
  } as ProviderRuntimeEvent);
}

async function runSubAgent(
  task: string,
  cwd: string,
  model: string,
  signal: AbortSignal,
  depth: number,
  progress?: SubAgentProgressContext,
): Promise<string> {
  if (depth >= MAX_SUB_AGENT_DEPTH) {
    return "Error: Maximum sub-agent nesting depth reached.";
  }

  const apiKey = resolveApiKey();
  if (!apiKey) return "Error: GLM API key not configured.";
  const baseUrl = resolveBaseUrl();

  if (progress) {
    const label = progress.agentName || "sub-agent";
    progress.emit({
      ...makeEventBase(progress.threadId, progress.turnId, progress.parentItemId),
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call" as CanonicalItemType,
        status: "inProgress",
        title: "spawn_agent",
        detail: `[${label}] Starting: ${task.slice(0, 140)}`,
        data: { agentName: progress.agentName, depth },
      },
    } as ProviderRuntimeEvent);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a focused sub-agent handling a specific task. ` +
        `You have access to tools to read, write, and edit files, run commands, list directories, search files, and spawn further sub-agents. ` +
        `The working directory is: ${cwd}\n\n` +
        `Complete the task and then write a clear, detailed summary of:\n` +
        `- What you did (files changed, commands run, etc.)\n` +
        `- The outcome (success/failure, key findings)\n` +
        `- Any issues encountered or things to note\n\n` +
        `Your final response is shown directly to the user, so make it informative and well-formatted. ` +
        `Do NOT ask questions — make reasonable decisions and proceed.`,
    },
    { role: "user", content: task },
  ];

  // Sub-agents can spawn further sub-agents but with reduced depth budget
  const subAgentTools = TOOL_DEFINITIONS;
  let finalResponse = "";

  for (let iteration = 0; iteration < MAX_SUB_AGENT_ITERATIONS; iteration++) {
    if (signal.aborted) return "Sub-agent interrupted.";

    if (progress) {
      emitSubAgentProgress(progress, `Iteration ${iteration + 1}/${MAX_SUB_AGENT_ITERATIONS} — thinking...`, depth);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: subAgentTools,
          stream: true,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return "Sub-agent interrupted.";
      return `Sub-agent API error: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return `Sub-agent API error ${response.status}: ${errorBody.slice(0, 300)}`;
    }

    let assistantContent = "";
    const toolCalls: Map<number, ToolCall> = new Map();

    for await (const chunk of parseSseStream(response, signal)) {
      const choice = chunk.choices?.[0];
      if (!choice?.delta) continue;
      if (choice.delta.content) {
        assistantContent += choice.delta.content;
      }
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCalls.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) {
              existing.function.arguments += tc.function.arguments;
            }
          } else {
            toolCalls.set(tc.index, {
              id: tc.id ?? `sub-call-${tc.index}`,
              type: "function",
              function: {
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "",
              },
            });
          }
        }
      }
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: assistantContent || null,
    };
    const resolvedToolCalls = Array.from(toolCalls.values());
    if (resolvedToolCalls.length > 0) {
      assistantMsg.tool_calls = resolvedToolCalls;
    }
    messages.push(assistantMsg);

    // No tool calls — sub-agent is done
    if (resolvedToolCalls.length === 0) {
      finalResponse = assistantContent;
      if (progress) {
        const label = progress.agentName || "sub-agent";
        // Flush the full streamed response (throttle may have skipped the last chunk)
        if (assistantContent) {
          progress.emit({
            ...makeEventBase(progress.threadId, progress.turnId, progress.parentItemId),
            type: "item.updated",
            payload: {
              itemType: "collab_agent_tool_call" as CanonicalItemType,
              status: "inProgress",
              title: "spawn_agent",
              detail: `[${label}] responding...`.slice(0, 180),
              data: {
                agentName: progress.agentName,
                depth,
                streamingResponse: assistantContent,
              },
            },
          } as ProviderRuntimeEvent);
        }
        // Emit final completion with the full summary
        progress.emit({
          ...makeEventBase(progress.threadId, progress.turnId, progress.parentItemId),
          type: "item.updated",
          payload: {
            itemType: "collab_agent_tool_call" as CanonicalItemType,
            status: "completed" as const,
            title: "spawn_agent",
            detail: `[${label}] Completed after ${iteration + 1} iteration(s)`,
            data: {
              agentName: progress.agentName,
              depth,
              summary: assistantContent,
            },
          },
        } as ProviderRuntimeEvent);
      }
      break;
    }

    // Execute tool calls
    for (const tc of resolvedToolCalls) {
      if (signal.aborted) return "Sub-agent interrupted.";

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = {};
      }

      // Emit progress for each tool the sub-agent uses
      if (progress) {
        const toolBrief =
          tc.function.name === "run_command"
            ? `run_command: ${String(parsedArgs.command ?? "").slice(0, 80)}`
            : tc.function.name === "read_file" || tc.function.name === "write_file" || tc.function.name === "edit_file"
              ? `${tc.function.name}: ${String(parsedArgs.path ?? "").slice(0, 80)}`
              : tc.function.name === "search_files"
                ? `search_files: ${String(parsedArgs.pattern ?? "").slice(0, 80)}`
                : tc.function.name === "spawn_agent"
                  ? `spawn_agent: ${String(parsedArgs.task ?? "").slice(0, 60)}`
                  : tc.function.name;
        emitSubAgentProgress(progress, toolBrief, depth);
      }

      let toolResult: string;
      if (tc.function.name === "spawn_agent") {
        // Recursive sub-agent
        const subTask = String(parsedArgs.task ?? "");
        const subCwd = parsedArgs.cwd ? String(parsedArgs.cwd) : cwd;
        toolResult = await runSubAgent(subTask, subCwd, model, signal, depth + 1, progress);
      } else {
        try {
          toolResult = await executeToolCall(tc.function.name, parsedArgs, cwd);
        } catch (error) {
          toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult.slice(0, 50_000),
      });
    }
  }

  return finalResponse || "Sub-agent completed without a final response.";
}

// ── SSE parser ────────────────────────────────────────────────────

interface SSEChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

async function* parseSseStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as SSEChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Adapter implementation ────────────────────────────────────────

export interface GlmAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export function makeGlmAdapterLive(_options?: GlmAdapterLiveOptions) {
  return Layer.effect(
    GlmAdapter,
    Effect.gen(function* () {
      const sessions = new Map<string, GlmSession>();
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      const emit = (event: ProviderRuntimeEvent) =>
        Effect.runSync(Queue.offer(eventQueue, event));

      const streamEvents: GlmAdapterShape["streamEvents"] =
        Stream.fromQueue(eventQueue);

      const getSession = (threadId: ThreadId): GlmSession => {
        const session = sessions.get(threadId);
        if (!session) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return session;
      };

      const capabilities: ProviderAdapterCapabilities = {
        sessionModelSwitch: "in-session",
      };

      const startSession: GlmAdapterShape["startSession"] = (input) =>
        Effect.sync(() => {
          const now = nowIso();
          const threadId = input.threadId;
          const model = input.model ?? "glm-4.7";
          const cwd = input.cwd ?? process.cwd();

          const session: GlmSession = {
            threadId,
            model,
            cwd,
            messages: [
              {
                role: "system",
                content:
                  `You are a helpful coding assistant and orchestrator. The working directory is: ${cwd}\n\n` +
                  `You have access to tools to read, write, and edit files, run commands, list directories, search files, and spawn sub-agents.\n\n` +
                  `## Orchestration Guidelines\n` +
                  `When facing complex tasks that involve multiple files or steps, act as a **manager**:\n` +
                  `1. **Plan first** — briefly explain to the user what you're about to do and which agents you'll create.\n` +
                  `2. **Delegate** — use \`spawn_agent\` with a clear, descriptive \`name\` (e.g. "test-runner", "schema-migrator") and a detailed \`task\`.\n` +
                  `3. **Summarize** — after all agents complete, synthesize their results into a clear summary for the user.\n\n` +
                  `Always give each agent a unique, descriptive name so the user can track what each agent is working on.\n` +
                  `Prefer spawning focused agents for distinct sub-tasks rather than one agent for everything.`,
              },
            ],
            activeTurnAbort: null,
            pendingApproval: null,
            status: "ready",
            createdAt: now,
            updatedAt: now,
            runtimeMode: input.runtimeMode ?? "full-access",
          };
          sessions.set(threadId, session);

          emit({
            ...makeEventBase(threadId),
            type: "session.started",
            payload: { message: `GLM session started with model ${model}` },
          } as ProviderRuntimeEvent);

          emit({
            ...makeEventBase(threadId),
            type: "session.state.changed",
            payload: { state: "ready" },
          } as ProviderRuntimeEvent);

          return {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: session.runtimeMode,
            cwd,
            model,
            threadId,
            createdAt: now,
            updatedAt: now,
          } as ProviderSession;
        });

      const runAgentLoop = async (
        session: GlmSession,
        turnId: TurnId,
        signal: AbortSignal,
      ) => {
        const apiKey = resolveApiKey();
        if (!apiKey) {
          emit({
            ...makeEventBase(session.threadId, turnId),
            type: "runtime.error",
            payload: {
              message: "GLM API key not configured. Set GLM_API_KEY or ZAI_API_KEY environment variable.",
              class: "provider_error",
            },
          } as ProviderRuntimeEvent);
          emit({
            ...makeEventBase(session.threadId, turnId),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: "API key not configured" },
          } as ProviderRuntimeEvent);
          session.status = "ready";
          return;
        }

        const baseUrl = resolveBaseUrl();

        for (let iteration = 0; iteration < MAX_AGENT_LOOP_ITERATIONS; iteration++) {
          if (signal.aborted) {
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "turn.completed",
              payload: { state: "interrupted" },
            } as ProviderRuntimeEvent);
            session.status = "ready";
            return;
          }

          let response: Response;
          try {
            response = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: session.model,
                messages: session.messages,
                tools: TOOL_DEFINITIONS,
                stream: true,
              }),
              signal,
            });
          } catch (error) {
            if (signal.aborted) {
              emit({
                ...makeEventBase(session.threadId, turnId),
                type: "turn.completed",
                payload: { state: "interrupted" },
              } as ProviderRuntimeEvent);
              session.status = "ready";
              return;
            }
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "runtime.error",
              payload: {
                message: `GLM API request failed: ${error instanceof Error ? error.message : String(error)}`,
                class: "transport_error",
              },
            } as ProviderRuntimeEvent);
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: "API request failed" },
            } as ProviderRuntimeEvent);
            session.status = "ready";
            return;
          }

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "runtime.error",
              payload: {
                message: `GLM API error ${response.status}: ${errorBody.slice(0, 500)}`,
                class: "provider_error",
              },
            } as ProviderRuntimeEvent);
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: `API error ${response.status}` },
            } as ProviderRuntimeEvent);
            session.status = "ready";
            return;
          }

          // Parse streaming response
          let assistantContent = "";
          const toolCalls: Map<number, ToolCall> = new Map();

          for await (const chunk of parseSseStream(response, signal)) {
            const choice = chunk.choices?.[0];
            if (!choice?.delta) continue;

            // Text content
            if (choice.delta.content) {
              assistantContent += choice.delta.content;
              emit({
                ...makeEventBase(session.threadId, turnId),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: choice.delta.content,
                },
              } as ProviderRuntimeEvent);
            }

            // Tool calls
            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const existing = toolCalls.get(tc.index);
                if (existing) {
                  if (tc.function?.arguments) {
                    existing.function.arguments += tc.function.arguments;
                  }
                } else {
                  toolCalls.set(tc.index, {
                    id: tc.id ?? `call-${tc.index}`,
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "",
                    },
                  });
                }
              }
            }
          }

          // Build assistant message
          const assistantMsg: ChatMessage = {
            role: "assistant",
            content: assistantContent || null,
          };
          const resolvedToolCalls = Array.from(toolCalls.values());
          if (resolvedToolCalls.length > 0) {
            assistantMsg.tool_calls = resolvedToolCalls;
          }
          session.messages.push(assistantMsg);

          // If no tool calls, turn is complete
          if (resolvedToolCalls.length === 0) {
            if (assistantContent) {
              const msgItemId = `msg-${nextEventId()}`;
              emit({
                ...makeEventBase(session.threadId, turnId, msgItemId),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                },
              } as ProviderRuntimeEvent);
            }
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "turn.completed",
              payload: { state: "completed" },
            } as ProviderRuntimeEvent);
            session.status = "ready";
            session.updatedAt = nowIso();
            return;
          }

          // If the model produced plan/explanation text alongside tool calls,
          // emit it as a completed assistant message so the UI renders it
          // before the tool calls start executing.
          if (assistantContent) {
            const msgItemId = `msg-${nextEventId()}`;
            emit({
              ...makeEventBase(session.threadId, turnId, msgItemId),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
              },
            } as ProviderRuntimeEvent);
          }

          // Prepare all tool calls with parsed args and metadata
          type PreparedToolCall = {
            tc: ToolCall;
            parsedArgs: Record<string, unknown>;
            toolItemId: string;
            canonicalType: CanonicalItemType;
            toolDetail: string;
            isSpawnAgent: boolean;
            agentName: string;
          };

          const prepared: PreparedToolCall[] = resolvedToolCalls.map((tc) => {
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }
            const toolItemId = `tool-${tc.id}`;
            const canonicalType = toolCallToCanonicalItemType(tc.function.name);
            const isSpawnAgent = tc.function.name === "spawn_agent";
            const agentName = isSpawnAgent ? String(parsedArgs.name ?? "") : "";
            const toolDetail =
              tc.function.name === "run_command"
                ? String(parsedArgs.command ?? "")
                : tc.function.name === "read_file" || tc.function.name === "write_file" || tc.function.name === "edit_file"
                  ? String(parsedArgs.path ?? "")
                  : isSpawnAgent
                    ? String(parsedArgs.task ?? "").slice(0, 120)
                    : tc.function.name;
            return { tc, parsedArgs, toolItemId, canonicalType, toolDetail, isSpawnAgent, agentName };
          });

          // Split into spawn_agent calls (run in parallel) and other tools (run sequentially)
          const spawnAgentCalls = prepared.filter((p) => p.isSpawnAgent);
          const otherToolCalls = prepared.filter((p) => !p.isSpawnAgent);

          // Helper to execute a single prepared tool call
          const executePrepared = async (p: PreparedToolCall): Promise<void> => {
            if (signal.aborted) return;

            const agentData = p.isSpawnAgent ? { agentName: p.agentName } : undefined;

            // Approval flow for write/execute operations in approval-required mode
            if (
              session.runtimeMode === "approval-required" &&
              (p.tc.function.name === "write_file" ||
                p.tc.function.name === "edit_file" ||
                p.tc.function.name === "run_command")
            ) {
              const requestId = `req-${nextEventId()}`;
              const requestType =
                p.tc.function.name === "run_command"
                  ? "exec_command_approval"
                  : "file_change_approval";

              emit({
                ...makeEventBase(session.threadId, turnId, p.toolItemId),
                type: "request.opened",
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                payload: {
                  requestType,
                  detail: p.toolDetail,
                  args: p.parsedArgs,
                },
              } as ProviderRuntimeEvent);

              const decision = await new Promise<string>((resolve) => {
                session.pendingApproval = { resolve, requestId };
              });
              session.pendingApproval = null;

              emit({
                ...makeEventBase(session.threadId, turnId, p.toolItemId),
                type: "request.resolved",
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                payload: {
                  requestType,
                  decision,
                },
              } as ProviderRuntimeEvent);

              if (decision === "decline" || decision === "cancel") {
                session.messages.push({
                  role: "tool",
                  tool_call_id: p.tc.id,
                  content: "Operation declined by user.",
                });
                return;
              }
            }

            // Emit item.started
            emit({
              ...makeEventBase(session.threadId, turnId, p.toolItemId),
              type: "item.started",
              payload: {
                itemType: p.canonicalType,
                title: p.isSpawnAgent && p.agentName ? `spawn_agent (${p.agentName})` : p.tc.function.name,
                detail: p.toolDetail,
                ...(agentData ? { data: agentData } : {}),
              },
            } as ProviderRuntimeEvent);

            // Execute
            let toolResult: string;
            try {
              if (p.isSpawnAgent) {
                const subTask = String(p.parsedArgs.task ?? "");
                const subCwd = p.parsedArgs.cwd ? String(p.parsedArgs.cwd) : session.cwd;
                const progressCtx: SubAgentProgressContext = {
                  threadId: session.threadId,
                  turnId,
                  parentItemId: p.toolItemId,
                  agentName: p.agentName,
                  emit,
                };
                toolResult = await runSubAgent(subTask, subCwd, session.model, signal, 0, progressCtx);
              } else {
                toolResult = await executeToolCall(p.tc.function.name, p.parsedArgs, session.cwd);
              }
            } catch (error) {
              toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
            }

            // Emit item.completed
            emit({
              ...makeEventBase(session.threadId, turnId, p.toolItemId),
              type: "item.completed",
              payload: {
                itemType: p.canonicalType,
                status: "completed",
                title: p.isSpawnAgent && p.agentName ? `spawn_agent (${p.agentName})` : p.tc.function.name,
                detail: p.toolDetail,
                ...(agentData ? { data: agentData } : {}),
              },
            } as ProviderRuntimeEvent);

            session.messages.push({
              role: "tool",
              tool_call_id: p.tc.id,
              content: toolResult.slice(0, 50_000),
            });
          };

          // Execute other tools sequentially first
          for (const p of otherToolCalls) {
            if (signal.aborted) break;
            await executePrepared(p);
          }

          // Execute spawn_agent calls in parallel
          if (spawnAgentCalls.length > 0 && !signal.aborted) {
            await Promise.all(spawnAgentCalls.map((p) => executePrepared(p)));
          }

          session.updatedAt = nowIso();
          // Loop continues: send tool results back to model
        }

        // If we hit the max iterations
        emit({
          ...makeEventBase(session.threadId, turnId),
          type: "turn.completed",
          payload: { state: "completed", stopReason: "max_iterations" },
        } as ProviderRuntimeEvent);
        session.status = "ready";
      };

      const sendTurn: GlmAdapterShape["sendTurn"] = (input) =>
        Effect.sync(() => {
          const session = getSession(input.threadId);
          const turnId = TurnId.makeUnsafe(`turn-${nextEventId()}`);

          if (input.model) {
            session.model = input.model;
          }

          if (input.input) {
            session.messages.push({ role: "user", content: input.input });
          }

          session.status = "running";
          const abortController = new AbortController();
          session.activeTurnAbort = abortController;

          emit({
            ...makeEventBase(session.threadId, turnId),
            type: "turn.started",
            payload: { model: session.model },
          } as ProviderRuntimeEvent);

          // Run agent loop in the background
          void runAgentLoop(session, turnId, abortController.signal).catch((error) => {
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "runtime.error",
              payload: {
                message: `Agent loop failed: ${error instanceof Error ? error.message : String(error)}`,
                class: "unknown",
              },
            } as ProviderRuntimeEvent);
            emit({
              ...makeEventBase(session.threadId, turnId),
              type: "turn.completed",
              payload: { state: "failed" },
            } as ProviderRuntimeEvent);
            session.status = "ready";
            session.activeTurnAbort = null;
          });

          return {
            threadId: session.threadId,
            turnId,
          } satisfies ProviderTurnStartResult;
        });

      const interruptTurn: GlmAdapterShape["interruptTurn"] = (threadId) =>
        Effect.sync(() => {
          const session = getSession(threadId);
          if (session.activeTurnAbort) {
            session.activeTurnAbort.abort();
            session.activeTurnAbort = null;
          }
          if (session.pendingApproval) {
            session.pendingApproval.resolve("cancel");
            session.pendingApproval = null;
          }
          session.status = "ready";
        });

      const respondToRequest: GlmAdapterShape["respondToRequest"] = (
        threadId,
        _requestId,
        decision,
      ) =>
        Effect.sync(() => {
          const session = getSession(threadId);
          if (session.pendingApproval) {
            session.pendingApproval.resolve(decision);
          }
        });

      const respondToUserInput: GlmAdapterShape["respondToUserInput"] = () =>
        Effect.void;

      const stopSession: GlmAdapterShape["stopSession"] = (threadId) =>
        Effect.sync(() => {
          const session = sessions.get(threadId);
          if (session) {
            if (session.activeTurnAbort) {
              session.activeTurnAbort.abort();
            }
            if (session.pendingApproval) {
              session.pendingApproval.resolve("cancel");
            }
            session.status = "stopped";
            sessions.delete(threadId);

            emit({
              ...makeEventBase(threadId),
              type: "session.exited",
              payload: { reason: "stopped", exitKind: "graceful" },
            } as ProviderRuntimeEvent);
          }
        });

      const listSessions: GlmAdapterShape["listSessions"] = () =>
        Effect.sync(() =>
          Array.from(sessions.values()).map(
            (s) =>
              ({
                provider: PROVIDER,
                status: s.status === "running" ? "running" : "ready",
                runtimeMode: s.runtimeMode,
                cwd: s.cwd,
                model: s.model,
                threadId: s.threadId,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
              }) as ProviderSession,
          ),
        );

      const hasSession: GlmAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: GlmAdapterShape["readThread"] = (threadId) =>
        Effect.sync(() => {
          getSession(threadId);
          return {
            threadId,
            turns: [],
          } satisfies ProviderThreadSnapshot;
        });

      const rollbackThread: GlmAdapterShape["rollbackThread"] = (threadId, numTurns) =>
        Effect.sync(() => {
          const session = getSession(threadId);
          // Simple rollback: remove last N user+assistant message pairs
          for (let i = 0; i < numTurns; i++) {
            while (session.messages.length > 1) {
              const last = session.messages[session.messages.length - 1];
              if (!last) break;
              session.messages.pop();
              if (last.role === "user") break;
            }
          }
          return {
            threadId,
            turns: [],
          } satisfies ProviderThreadSnapshot;
        });

      const stopAll: GlmAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          for (const threadId of sessions.keys()) {
            yield* stopSession(ThreadId.makeUnsafe(threadId));
          }
        });

      return {
        provider: PROVIDER,
        capabilities,
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        streamEvents,
      } satisfies GlmAdapterShape;
    }),
  );
}
