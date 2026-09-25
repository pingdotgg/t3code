import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tracer from "effect/Tracer";
import type { ThreadTitleGenerationInput } from "../textGeneration/TextGeneration.ts";

// Exec exposes tool events and aggregate turn usage, not individual model
// requests or the provider's full system context. Never invent those spans.
const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      thread_id: Schema.optionalKey(Schema.String),
      usage: Schema.optionalKey(
        Schema.Struct({
          input_tokens: Schema.Finite,
          output_tokens: Schema.Finite,
          cached_input_tokens: Schema.optionalKey(Schema.Finite),
          reasoning_output_tokens: Schema.optionalKey(Schema.Finite),
        }),
      ),
      item: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          type: Schema.String,
          status: Schema.optionalKey(Schema.String),
          command: Schema.optionalKey(Schema.String),
          aggregated_output: Schema.optionalKey(Schema.String),
          exit_code: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
          server: Schema.optionalKey(Schema.String),
          tool: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.Unknown),
          result: Schema.optionalKey(Schema.Unknown),
          query: Schema.optionalKey(Schema.String),
          action: Schema.optionalKey(Schema.Unknown),
          results: Schema.optionalKey(Schema.Unknown),
          changes: Schema.optionalKey(Schema.Unknown),
        }),
      ),
    }),
  ),
);
const MESSAGE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    "gen_ai.input.messages": { type: "array" },
    "gen_ai.output.messages": { type: "array" },
    "t3.title.source_messages": { type: "array" },
  },
});
const TOOL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    "gen_ai.tool.call.arguments": { type: "object" },
    "gen_ai.tool.call.result": {},
  },
});

function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,})\b/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|authorization)\s*[=:]\s*["']?)([^\s"',;}]+)/gi,
      "$1[redacted]",
    );
}

/** Explicit spans keep title diagnostics available with background tracing off. */
export function startThreadTitleTelemetry(input: {
  tracer: Tracer.Tracer | undefined;
  captureContent: boolean;
  model: string;
  nowMs: () => number;
  prompt: string;
  promptSource?: string;
  generationMode?: "initial" | "regenerate";
  conversation?: string;
  context?: ThreadTitleGenerationInput["context"];
  threadId?: string | undefined;
  requestId?: string | undefined;
}) {
  let root: Tracer.Span | undefined;
  let provider: Tracer.Span | undefined;
  let finished = false;
  let toolCount = 0;
  let eventsComplete = false;
  let decodeErrors = 0;
  const tools = new Map<string, Tracer.Span>();
  const completedTools = new Set<string>();
  const start = input.nowMs();
  const now = () => BigInt(input.nowMs()) * 1_000_000n;
  const safely = (work: () => void) => {
    try {
      work();
    } catch {
      /* Export failure must not change generation. */
    }
  };
  const attributes = (span: Tracer.Span | undefined, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) span?.attribute(key, value);
  };
  const create = (
    name: string,
    parent: Tracer.Span | undefined,
    values: Record<string, unknown>,
  ) => {
    const span = input.tracer?.span({
      name,
      parent: Option.fromUndefinedOr(parent),
      annotations: Context.empty(),
      links: [],
      startTime: now(),
      kind: parent ? "client" : "internal",
      root: !parent,
      sampled: true,
    });
    attributes(span, {
      "logfire.msg": name,
      "t3.thread.id": input.threadId,
      "t3.request.id": input.requestId,
      ...values,
    });
    return span;
  };
  const content = (span: Tracer.Span | undefined, key: string, value: unknown) => {
    if (input.captureContent && value !== undefined)
      span?.attribute(
        key,
        JSON.stringify(value, (field, item: unknown) =>
          /^(api[_-]?key|access[_-]?token|password|authorization)$/i.test(field)
            ? "[redacted]"
            : typeof item === "string"
              ? redact(item)
              : item,
        ),
      );
  };
  safely(() => {
    root = create("generate thread title", undefined, {
      "gen_ai.request.model": input.model,
      "gen_ai.conversation.id": input.threadId,
      "t3.title.prompt_sha256": NodeCrypto.createHash("sha256").update(input.prompt).digest("hex"),
      "t3.title.prompt_source": input.promptSource ?? "unknown",
      "t3.title.generation_mode": input.generationMode,
      "t3.title.supplied_prompt_characters": input.prompt.length,
      "t3.title.context_truncated":
        input.prompt.includes("[Earlier content truncated]") ||
        input.prompt.includes("[Content truncated]") ||
        input.prompt.includes("[truncated]"),
      "t3.title.source_message_count":
        input.context?.sourceMessageCount ?? (input.conversation === undefined ? undefined : 1),
      "t3.title.retained_message_count": input.context?.retainedMessageCount,
      "t3.title.dropped_message_indices": input.context?.droppedMessageIndices,
      "t3.title.truncated_message_indices": input.context?.truncatedMessageIndices,
      "logfire.json_schema": MESSAGE_SCHEMA,
    });
    content(root, "gen_ai.input.messages", [
      { role: "user", parts: [{ type: "text", content: input.prompt }] },
    ]);
    // Bound diagnostic history separately from the actual supplied model input.
    const source =
      input.context?.sourceMessages ??
      (input.conversation === undefined
        ? undefined
        : [{ index: 0, role: "user", text: input.conversation }]);
    if (source) {
      let budget = 64_000;
      const captured = source.flatMap((message) => {
        if (budget <= 0) return [];
        const text = message.text.slice(0, budget);
        budget -= text.length;
        return [{ ...message, text }];
      });
      attributes(root, {
        "t3.title.source_capture_truncated":
          source.reduce((count, message) => count + message.text.length, 0) > 64_000,
      });
      content(root, "t3.title.source_messages", captured);
    }
  });
  return {
    providerStarted: (config: { model: string; reasoningEffort: string }) =>
      safely(() => {
        provider = create("invoke_agent codex.title", root, {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "codex.title",
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": config.model,
          "gen_ai.conversation.id": input.threadId,
          "t3.title.reasoning_effort": config.reasoningEffort,
          "t3.genai.input_messages_scope": "supplied_prompt_only",
          "t3.genai.model_requests_visible": false,
          "t3.genai.usage_scope": "provider_turn_total",
          "logfire.json_schema": MESSAGE_SCHEMA,
        });
        content(provider, "gen_ai.input.messages", [
          { role: "user", parts: [{ type: "text", content: input.prompt }] },
        ]);
      }),
    event: (line: string) =>
      safely(() => {
        if (finished || !line.trim()) return;
        const decoded = decodeEvent(line);
        if (Option.isNone(decoded)) {
          decodeErrors++;
          return;
        }
        const event = decoded.value;
        if (event.type === "thread.started")
          attributes(provider, { "t3.provider.thread_id": event.thread_id });
        if (event.type === "turn.completed" && event.usage) {
          eventsComplete = true;
          attributes(provider, {
            "gen_ai.aggregated_usage.input_tokens": event.usage.input_tokens,
            "gen_ai.aggregated_usage.output_tokens": event.usage.output_tokens,
            "gen_ai.aggregated_usage.cache_read.input_tokens": event.usage.cached_input_tokens,
            "gen_ai.aggregated_usage.details.reasoning_tokens": event.usage.reasoning_output_tokens,
          });
        }
        const item = event.item;
        if (
          !item ||
          !["item.started", "item.updated", "item.completed"].includes(event.type) ||
          completedTools.has(item.id)
        )
          return;
        if (
          ![
            "command_execution",
            "mcp_tool_call",
            "web_search",
            "file_change",
            "collab_tool_call",
          ].includes(item.type)
        )
          return;
        const name =
          item.type === "mcp_tool_call" ? `${item.server}.${item.tool}` : (item.tool ?? item.type);
        let tool = tools.get(item.id);
        if (!tool) {
          tool = create(`execute_tool ${name}`, provider ?? root, {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.id": item.id,
            "t3.provider.item_type": item.type,
            "t3.tool.start_observed": event.type === "item.started",
            "logfire.json_schema": TOOL_SCHEMA,
          });
          if (tool) tools.set(item.id, tool);
          toolCount++;
        }
        const args =
          item.type === "command_execution"
            ? { command: item.command }
            : item.type === "web_search"
              ? { query: item.query, action: item.action }
              : item.type === "file_change"
                ? { changes: item.changes }
                : item.arguments;
        content(tool, "gen_ai.tool.call.arguments", args);
        if (event.type === "item.completed") {
          content(
            tool,
            "gen_ai.tool.call.result",
            item.type === "command_execution"
              ? { output: item.aggregated_output, exit_code: item.exit_code }
              : (item.result ?? item.results),
          );
          const failed =
            ["failed", "declined"].includes(item.status ?? "") ||
            (item.exit_code != null && item.exit_code !== 0);
          attributes(tool, {
            "t3.tool.status": item.status ?? "completed",
            ...(failed ? { "error.type": "ToolExecutionError" } : {}),
          });
          tool?.end(now(), failed ? Exit.fail("Tool execution failed") : Exit.void);
          tools.delete(item.id);
          completedTools.add(item.id);
        }
      }),
    rawOutput: (raw: string) =>
      safely(() => {
        if (input.captureContent) root?.attribute("t3.title.raw_output", redact(raw));
        const messages = [{ role: "assistant", parts: [{ type: "text", content: raw }] }];
        content(root, "gen_ai.output.messages", messages);
        content(provider, "gen_ai.output.messages", messages);
      }),
    finish: (result: { title: string } | undefined) =>
      safely(() => {
        if (finished) return;
        finished = true;
        const exit = result ? Exit.void : Exit.fail("Thread title generation failed");
        for (const tool of tools.values()) {
          tool.attribute("error.type", "IncompleteToolExecution");
          tool.end(now(), Exit.fail("Provider ended before reporting tool completion"));
        }
        tools.clear();
        const completion = {
          "t3.title.tool_count": toolCount,
          "t3.title.provider_events_complete": eventsComplete,
          "t3.title.event_decode_errors": decodeErrors,
        };
        attributes(provider, completion);
        provider?.end(now(), exit);
        if (result && input.captureContent) root?.attribute("t3.title.final", redact(result.title));
        attributes(root, {
          ...completion,
          "t3.title.duration_ms": input.nowMs() - start,
          "t3.title.succeeded": result !== undefined,
          ...(!result ? { "error.type": "ThreadTitleGenerationError" } : {}),
        });
        root?.end(now(), exit);
      }),
  };
}
