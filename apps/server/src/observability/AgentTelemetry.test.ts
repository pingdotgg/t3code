import { assert, describe, it } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { AgentTelemetryRecorder } from "./AgentTelemetry.ts";

const THREAD = "thread-1";
const TURN = "turn-1";

function makeRecorder(captureContent = true) {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const recorder = new AgentTelemetryRecorder({
    tracer,
    captureContent,
    staticAttributes: { "host.name": "test-host" },
    nowMs: () => Date.parse("2026-01-01T00:10:00.000Z"),
  });
  const real = () =>
    spans.filter((span) => span.attributes.get("logfire.span_type") !== "pending_span");
  const named = (prefix: string) => real().filter((span) => span.name.startsWith(prefix));
  return { recorder, spans, real, named };
}

const isoAt = (second: number) =>
  `2026-01-01T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${(second % 60)
    .toFixed(3)
    .padStart(6, "0")}Z`;

let seq = 0;
function event(
  type: string,
  second: number,
  fields: Record<string, unknown> = {},
): ProviderRuntimeEvent {
  seq += 1;
  return {
    eventId: `event-${seq}`,
    provider: "claudeAgent",
    threadId: THREAD,
    turnId: TURN,
    createdAt: isoAt(second),
    type,
    ...fields,
  } as unknown as ProviderRuntimeEvent;
}

/** A Claude response whose request started at `startSecond` (from ttft). */
const claudeResponse = (
  second: number,
  input: number,
  output: number,
  finishReason: string,
  timing?: { startSecond: number; firstChunkSecond: number },
  toolCalls?: Array<{ id: string; name: string }>,
) =>
  event("model.response.completed", second, {
    payload: {
      responseId: `msg-${second}`,
      model: "claude-sonnet-5-20260101",
      finishReason,
      ...(toolCalls ? { toolCalls } : {}),
      ...(timing
        ? {
            requestStartedAt: isoAt(timing.startSecond),
            requestStartSource: "provider_ttft",
            firstChunkAt: isoAt(timing.firstChunkSecond),
          }
        : {}),
      usage: {
        inputTokens: input + 110,
        outputTokens: output,
        cachedInputTokens: 100,
        cacheCreationTokens: 10,
      },
    },
  });

const bashTool = (
  lifecycle: "item.started" | "item.completed",
  second: number,
  id: string,
  options: { command: string; result?: string; isError?: boolean; status?: string },
) =>
  event(lifecycle, second, {
    itemId: id,
    payload: {
      itemType: "command_execution",
      status: options.status ?? (lifecycle === "item.started" ? "inProgress" : "completed"),
      title: "Command",
      data: {
        toolName: "Bash",
        input: { command: options.command },
        ...(options.result !== undefined
          ? {
              result: {
                type: "tool_result",
                tool_use_id: id,
                content: options.result,
                is_error: options.isError === true,
              },
            }
          : {}),
      },
    },
  });

const endExit = (span: Tracer.NativeSpan) => {
  assert.strictEqual(span.status._tag, "Ended");
  return (span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).exit;
};

describe("AgentTelemetryRecorder", () => {
  it("exports readable messages while the run is active and a native conversation on completion", () => {
    const { recorder, named } = makeRecorder();
    const prompt = `Implement offline search. ${"diagnostics ".repeat(1_500)}End of report.`;
    recorder.bindTurnInput(
      recorder.noteTurnInput({
        threadId: THREAD,
        text: prompt,
        attachmentCount: 0,
        model: "claude-sonnet-5",
        link: undefined,
      }),
      TURN,
    );
    recorder.handle(event("turn.started", 0, { payload: {} }));
    const agent = named("invoke_agent")[0]!;
    const input = named("user message")[0]!;
    assert.strictEqual(agent.status._tag, "Started");
    assert.strictEqual(input.status._tag, "Ended");
    assert.strictEqual(Option.getOrUndefined(input.parent)?.spanId, agent.spanId);
    assert.strictEqual(
      JSON.parse(String(input.attributes.get("gen_ai.input.messages")))[0].parts[0].content,
      prompt,
    );
    recorder.handle(
      event("content.delta", 1, {
        itemId: "text-1",
        payload: { streamKind: "assistant_text", delta: "I will inspect the input." },
      }),
    );
    assert.strictEqual(named("assistant message").length, 0);
    recorder.handle(
      event("item.completed", 2, {
        itemId: "text-1",
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    const output = named("assistant message")[0]!;
    assert.strictEqual(agent.status._tag, "Started");
    assert.strictEqual(output.status._tag, "Ended");
    assert.include(
      String(output.attributes.get("gen_ai.output.messages")),
      "I will inspect the input.",
    );
    recorder.handle(claudeResponse(3, 10, 5, "end_turn"));
    recorder.handle(event("turn.completed", 4, { payload: { state: "completed" } }));
    const conversation = JSON.parse(String(agent.attributes.get("pydantic_ai.all_messages")));
    assert.deepStrictEqual(
      conversation.map((message: { role: string }) => message.role),
      ["user", "assistant"],
    );
    assert.strictEqual(conversation[0].parts[0].content, prompt);
    assert.strictEqual(conversation[1].parts[0].content, "I will inspect the input.");
    assert.isFalse(agent.attributes.has("all_messages_events"));
    assert.isFalse(agent.attributes.has("gen_ai.input.messages"));
    assert.isFalse(agent.attributes.has("gen_ai.output.messages"));
    assert.strictEqual(agent.attributes.get("t3.genai.system_instructions_captured"), false);
    assert.strictEqual(named("chat ").length, 1);
  });

  it("gives an MCP call inside exec native arguments and results without counting it as a model call", () => {
    const { recorder, named, spans } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(
      codex("model.tool_call.started", 1, {
        payload: { callId: "exec-1", name: "exec", arguments: "tools.query_run(...)" },
      }),
    );
    const item = {
      type: "mcpToolCall",
      server: "logfire",
      tool: "query_run",
      arguments: JSON.stringify({
        query: "SELECT span_name FROM records LIMIT 1",
        api_key: "private-key",
      }),
    };
    recorder.handle(
      codex("item.started", 2, {
        itemId: "mcp-1",
        payload: { itemType: "mcp_tool_call", status: "inProgress", data: { item } },
      }),
    );
    const tool = named("execute_tool logfire.query_run")[0]!;
    const call = named("execute_tool exec")[0]!;
    assert.strictEqual(Option.getOrUndefined(tool.parent)?.spanId, call.spanId);
    const pending = spans.find(
      (span) =>
        span.name === tool.name && span.attributes.get("logfire.span_type") === "pending_span",
    )!;
    assert.include(
      String(pending.attributes.get("gen_ai.tool.call.arguments")),
      "SELECT span_name",
    );
    assert.notInclude(String(pending.attributes.get("gen_ai.tool.call.arguments")), "private-key");
    recorder.handle(
      codex("item.completed", 3, {
        itemId: "mcp-1",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              ...item,
              result: { content: [{ type: "text", text: "generate thread title" }] },
            },
          },
        },
      }),
    );
    assert.deepStrictEqual(JSON.parse(String(tool.attributes.get("gen_ai.tool.call.result"))), {
      content: [{ type: "text", text: "generate thread title" }],
    });
    recorder.handle(
      codex("model.tool_call.completed", 4, {
        payload: { callId: "exec-1", output: "one matching span" },
      }),
    );
    assert.strictEqual(
      JSON.parse(String(call.attributes.get("gen_ai.tool.call.result"))),
      "one matching span",
    );
    recorder.handle(codex("turn.completed", 5, { payload: { state: "completed" } }));
    assert.strictEqual(named("invoke_agent")[0]!.attributes.get("t3.agent.tool_calls"), 1);
    assert.strictEqual(named("invoke_agent")[0]!.attributes.get("t3.agent.tool_executions"), 1);
  });

  it("records a Claude turn as agent, chat, and tool spans", () => {
    const { recorder, spans, named } = makeRecorder();
    recorder.bindTurnInput(
      recorder.noteTurnInput({
        threadId: THREAD,
        text: "Fix the failing test",
        attachmentCount: 0,
        model: "claude-sonnet-5",
        link: undefined,
      }),
      TURN,
    );
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("content.delta", 1, {
        itemId: "text-1",
        payload: { streamKind: "assistant_text", delta: "Running the tests." },
      }),
    );
    recorder.handle(
      event("item.completed", 2, {
        itemId: "text-1",
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    recorder.handle(bashTool("item.started", 2, "tool-1", { command: "npm test" }));
    recorder.handle(
      claudeResponse(3, 5, 40, "tool_use", { startSecond: 0.5, firstChunkSecond: 1 }, [
        { id: "tool-1", name: "Bash" },
      ]),
    );
    recorder.handle(
      bashTool("item.completed", 6, "tool-1", {
        command: "npm test",
        result: "1 failing",
        isError: true,
        status: "failed",
      }),
    );
    recorder.handle(
      event("item.completed", 8, {
        itemId: "text-2",
        payload: { itemType: "assistant_message", status: "completed", detail: "Fixed it." },
      }),
    );
    recorder.handle(
      claudeResponse(9, 7, 20, "end_turn", { startSecond: 6.25, firstChunkSecond: 7 }),
    );
    recorder.handle(
      event("turn.completed", 10, {
        payload: {
          state: "completed",
          totalCostUsd: 0.12,
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 232,
            outputTokens: 60,
            hasSubagents: false,
          },
        },
      }),
    );

    const [agent] = named("invoke_agent");
    assert.isDefined(agent);
    assert.strictEqual(agent!.attributes.get("gen_ai.agent.name"), "T3 Code / Claude");
    assert.strictEqual(agent!.attributes.get("gen_ai.request.model"), "claude-sonnet-5");
    assert.strictEqual(agent!.attributes.get("gen_ai.conversation.id"), THREAD);
    assert.strictEqual(agent!.attributes.get("t3.agent.model_requests"), 2);
    assert.strictEqual(agent!.attributes.get("t3.agent.tool_calling_requests"), 1);
    assert.strictEqual(agent!.attributes.get("t3.agent.tool_calls"), 1);
    assert.strictEqual(agent!.attributes.get("t3.agent.failed_tool_calls"), 1);
    assert.strictEqual(agent!.attributes.get("final_result"), "Fixed it.");
    assert.isTrue(Exit.isSuccess(endExit(agent!)));

    const chats = named("chat ");
    assert.strictEqual(chats.length, 2);
    // Input counts cache reads and writes, like Pydantic AI.
    assert.strictEqual(chats[0]!.attributes.get("gen_ai.usage.input_tokens"), 115);
    assert.strictEqual(chats[0]!.attributes.get("gen_ai.usage.cache_read.input_tokens"), 100);
    assert.deepStrictEqual(chats[0]!.attributes.get("gen_ai.response.finish_reasons"), [
      "tool_use",
    ]);
    // Start times come from the provider, not from neighbouring events.
    assert.strictEqual(chats[0]!.attributes.get("t3.genai.chat.start_source"), "provider_ttft");
    assert.strictEqual(chats[1]!.startTime, BigInt(Date.parse(isoAt(6.25))) * 1_000_000n);
    assert.strictEqual(
      chats[1]!.attributes.get("gen_ai.client.operation.time_to_first_chunk"),
      0.75,
    );
    assert.strictEqual(
      chats[0]!.attributes.get("gen_ai.response.model"),
      "claude-sonnet-5-20260101",
    );
    const firstOutput = JSON.parse(chats[0]!.attributes.get("gen_ai.output.messages") as string);
    assert.deepStrictEqual(
      firstOutput[0].parts.map((part: { type: string }) => part.type),
      ["text", "tool_call"],
    );
    const secondInput = JSON.parse(chats[1]!.attributes.get("gen_ai.input.messages") as string);
    assert.strictEqual(secondInput[0].parts[0].type, "tool_call_response");
    assert.strictEqual(secondInput[0].parts[0].result, "1 failing");

    const [tool] = named("execute_tool");
    assert.strictEqual(tool!.attributes.get("gen_ai.tool.name"), "Bash");
    assert.strictEqual(
      tool!.attributes.get("gen_ai.tool.call.arguments"),
      '{"command":"npm test"}',
    );
    assert.strictEqual(Option.getOrUndefined(tool!.parent)?.spanId, agent!.spanId);
    // Claude streamed the call from 2 s; it could only run once the response ended at 3 s.
    assert.strictEqual(tool!.startTime, BigInt(Date.parse(isoAt(3))) * 1_000_000n);
    assert.strictEqual(tool!.attributes.get("t3.tool.call_streaming_ms"), 1000);
    assert.isTrue(Exit.isFailure(endExit(tool!)));

    // Agent and tool each get a pending twin so they show while running.
    const pending = spans.filter(
      (span) => span.attributes.get("logfire.span_type") === "pending_span",
    );
    assert.strictEqual(pending.length, 2);
    assert.strictEqual(Option.getOrUndefined(pending[0]!.parent)?.spanId, agent!.spanId);
    assert.strictEqual(pending[0]!.attributes.get("logfire.pending_parent_id"), "0000000000000000");
    assert.strictEqual(recorder.openRunCount, 0);
  });

  it("counts repeated Codex usage snapshots once", () => {
    const { recorder, named } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    const usage = (second: number, total: number) =>
      codex("thread.token-usage.updated", second, {
        payload: { usage: { usedTokens: total } },
        raw: {
          source: "codex.app-server.notification",
          method: "thread/tokenUsage/updated",
          payload: {
            tokenUsage: {
              total: { inputTokens: total, outputTokens: 10 },
              last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
            },
          },
        },
      });
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(usage(1, 100));
    recorder.handle(usage(2, 100));
    recorder.handle(usage(3, 200));
    recorder.handle(codex("turn.completed", 4, { payload: { state: "completed" } }));

    assert.strictEqual(named("chat ").length, 2);
    const [agent] = named("invoke_agent");
    assert.strictEqual(agent!.attributes.get("gen_ai.agent.name"), "T3 Code / Codex");
    assert.strictEqual(agent!.attributes.get("t3.usage.status"), "summed_from_responses");
    assert.strictEqual(agent!.attributes.get("gen_ai.aggregated_usage.input_tokens"), 200);
  });

  it("ends unfinished tools and the run as interrupted when a turn aborts", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(bashTool("item.started", 1, "tool-1", { command: "sleep 100" }));
    recorder.handle(event("turn.aborted", 5, { payload: { reason: "User interrupted" } }));

    const [tool] = named("execute_tool");
    const [agent] = named("invoke_agent");
    assert.strictEqual(tool!.attributes.get("t3.tool.status"), "unfinished");
    assert.isTrue(
      Cause.hasInterruptsOnly((endExit(tool!) as Exit.Failure<unknown, unknown>).cause),
    );
    assert.isTrue(
      Cause.hasInterruptsOnly((endExit(agent!) as Exit.Failure<unknown, unknown>).cause),
    );
    assert.strictEqual(agent!.attributes.get("t3.turn.state"), "interrupted");
  });

  it("marks a failed turn as an error with the provider's message", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("turn.completed", 2, { payload: { state: "failed", errorMessage: "Overloaded" } }),
    );
    const exit = endExit(named("invoke_agent")[0]!);
    assert.isTrue(Exit.isFailure(exit));
    assert.include(Cause.pretty((exit as Exit.Failure<unknown, unknown>).cause), "Overloaded");
  });

  it("omits message and tool content unless capture is enabled", () => {
    const { recorder, real } = makeRecorder(false);
    recorder.noteTurnInput({
      threadId: THREAD,
      text: "secret plan",
      attachmentCount: 0,
      model: undefined,
      link: undefined,
    });
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(bashTool("item.started", 1, "tool-1", { command: "cat .env" }));
    recorder.handle(
      bashTool("item.completed", 2, "tool-1", { command: "cat .env", result: "X=1" }),
    );
    recorder.handle(claudeResponse(3, 1, 1, "end_turn"));
    recorder.handle(event("turn.completed", 4, { payload: { state: "completed" } }));

    for (const span of real()) {
      for (const key of [
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "pydantic_ai.all_messages",
        "final_result",
      ]) {
        assert.isFalse(span.attributes.has(key), `${span.name} carried ${key}`);
      }
    }
  });

  it("scrubs sensitive argument keys", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("item.completed", 1, {
        itemId: "mcp-1",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            toolName: "deploy",
            input: {
              api_key: "sk-live-123",
              access_token: "tok-abc",
              authorization: { value: "Bearer secret-token" },
              session_ids: ["secret-session"],
              retries: 3,
              region: "us",
            },
          },
        },
      }),
    );
    const args = JSON.parse(
      named("execute_tool")[0]!.attributes.get("gen_ai.tool.call.arguments") as string,
    );
    assert.strictEqual(args.region, "us");
    assert.notInclude(args.api_key, "sk-live");
    // Nested objects and arrays under a sensitive key are hidden too.
    assert.notInclude(JSON.stringify(args), "secret-token");
    assert.notInclude(JSON.stringify(args), "secret-session");
    assert.notInclude(JSON.stringify(args), "tok-abc");
  });

  it("ignores events for turns it never saw start and duplicate starts", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(bashTool("item.started", 1, "tool-1", { command: "ls" }));
    recorder.handle(event("turn.started", 2, { payload: {} }));
    recorder.handle(event("turn.started", 3, { payload: {} }));
    recorder.handle(event("turn.completed", 4, { payload: { state: "completed" } }));
    assert.strictEqual(named("invoke_agent").length, 1);
    assert.strictEqual(named("execute_tool").length, 0);
  });

  it("closes open runs on shutdown", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.closeAll("shutdown");
    assert.strictEqual(recorder.openRunCount, 0);
    assert.strictEqual(named("invoke_agent")[0]!.status._tag, "Ended");
  });

  it("ends Codex chat spans at the reported response, before its tools run", () => {
    const { recorder, named } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(
      codex("model.response.completed", 4, {
        payload: {
          responseId: "resp-1",
          requestStartedAt: isoAt(1),
          requestStartSource: "input_recorded",
          firstChunkAt: isoAt(2.5),
          usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
        },
      }),
    );
    recorder.handle(
      codex("item.started", 5, {
        itemId: "exec-1",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          data: { item: { type: "commandExecution", command: "npm test" } },
        },
      }),
    );
    recorder.handle(
      codex("item.completed", 7, {
        itemId: "exec-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            item: {
              type: "commandExecution",
              command: "npm test",
              exitCode: 0,
              aggregatedOutput: "ok",
            },
          },
        },
      }),
    );
    // Codex's usage snapshot lands after the tool; it must not add a response.
    recorder.handle(
      codex("thread.token-usage.updated", 7, {
        payload: { usage: { usedTokens: 110 } },
        raw: {
          source: "codex.app-server.notification",
          method: "thread/tokenUsage/updated",
          payload: {
            tokenUsage: {
              total: { inputTokens: 100 },
              last: { inputTokens: 100, outputTokens: 10 },
            },
          },
        },
      }),
    );
    recorder.handle(codex("turn.completed", 8, { payload: { state: "completed" } }));

    const chats = named("chat ");
    assert.strictEqual(chats.length, 1);
    const chat = chats[0]!;
    assert.strictEqual(chat.attributes.get("t3.genai.chat.start_source"), "input_recorded");
    assert.strictEqual(chat.startTime, BigInt(Date.parse(isoAt(1))) * 1_000_000n);
    assert.strictEqual(endExit(chat)._tag, "Success");
    assert.strictEqual(
      (chat.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(4))) * 1_000_000n,
    );
    assert.strictEqual(chat.attributes.get("gen_ai.client.operation.time_to_first_chunk"), 1.5);
    assert.strictEqual(named("invoke_agent")[0]!.attributes.get("t3.agent.model_requests"), 1);
  });

  it("records a Codex model tool call with its executions nested under it", () => {
    const { recorder, named, real } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(
      codex("model.tool_call.started", 2, {
        payload: {
          callId: "call_1",
          name: "exec",
          arguments: 'tools.exec_command({cmd:"npm test"})',
        },
      }),
    );
    recorder.handle(
      codex("model.response.completed", 2, {
        payload: {
          requestStartedAt: isoAt(0.5),
          requestStartSource: "input_recorded",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      }),
    );
    const execItem = (type: "item.started" | "item.completed", second: number) =>
      codex(type, second, {
        itemId: "exec-1",
        payload: {
          itemType: "command_execution",
          status: type === "item.started" ? "inProgress" : "failed",
          data: {
            item: {
              type: "commandExecution",
              command: "pwsh -Command npm test",
              ...(type === "item.completed" ? { exitCode: 1, aggregatedOutput: "1 failing" } : {}),
            },
          },
        },
      });
    recorder.handle(execItem("item.started", 3));
    recorder.handle(execItem("item.completed", 4));
    recorder.handle(
      codex("model.tool_call.completed", 4.5, {
        payload: { callId: "call_1", output: "Exit code 1: 1 failing" },
      }),
    );
    recorder.handle(
      codex("model.response.completed", 6, {
        payload: {
          requestStartedAt: isoAt(4.5),
          requestStartSource: "input_recorded",
          usage: { inputTokens: 120, outputTokens: 5 },
        },
      }),
    );
    recorder.handle(codex("turn.completed", 7, { payload: { state: "completed" } }));

    const [call] = named("execute_tool exec");
    assert.isDefined(call);
    assert.strictEqual(call!.attributes.get("gen_ai.tool.call.id"), "call_1");
    assert.strictEqual(call!.startTime, BigInt(Date.parse(isoAt(2))) * 1_000_000n);
    assert.strictEqual(
      (call!.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(4.5))) * 1_000_000n,
    );
    assert.strictEqual(call!.attributes.get("t3.tool.failed_executions"), 1);

    const execution = real().find((span) => span.name === "execute_tool command_execution");
    assert.isDefined(execution);
    assert.strictEqual(Option.getOrUndefined(execution!.parent)?.spanId, call!.spanId);
    assert.strictEqual(execution!.attributes.get("gen_ai.operation.name"), "execute_tool");
    assert.strictEqual(execution!.attributes.get("t3.tool.nested_execution"), true);
    assert.isTrue(Exit.isFailure(endExit(execution!)));

    // The model's call and its result share one id in the transcript.
    const chats = named("chat ");
    const firstOutput = JSON.parse(chats[0]!.attributes.get("gen_ai.output.messages") as string);
    assert.strictEqual(firstOutput[0].parts[0].id, "call_1");
    const secondInput = JSON.parse(chats[1]!.attributes.get("gen_ai.input.messages") as string);
    assert.strictEqual(secondInput[0].parts[0].type, "tool_call_response");
    assert.strictEqual(secondInput[0].parts[0].id, "call_1");

    const [agent] = named("invoke_agent");
    assert.strictEqual(agent!.attributes.get("t3.agent.tool_calls"), 1);
    assert.strictEqual(agent!.attributes.get("t3.agent.tool_executions"), 1);
    assert.strictEqual(agent!.attributes.get("t3.agent.tool_calling_requests"), 1);
  });

  it("does not duplicate a Claude tool that finished before its response ended", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(bashTool("item.started", 1, "tool-1", { command: "ls" }));
    recorder.handle(bashTool("item.completed", 1.5, "tool-1", { command: "ls", result: "a" }));
    recorder.handle(
      claudeResponse(2, 1, 1, "tool_use", { startSecond: 0.2, firstChunkSecond: 0.5 }, [
        { id: "tool-1", name: "Bash" },
      ]),
    );
    recorder.handle(event("turn.completed", 3, { payload: { state: "completed" } }));

    const tools = named("execute_tool");
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0]!.startTime, BigInt(Date.parse(isoAt(1))) * 1_000_000n);
    assert.strictEqual(tools[0]!.attributes.get("t3.tool.duration_upper_bound"), true);
    const output = JSON.parse(
      named("chat ")[0]!.attributes.get("gen_ai.output.messages") as string,
    );
    assert.strictEqual(
      output[0].parts.filter((part: { type: string }) => part.type === "tool_call").length,
      1,
    );
  });

  it("ends Codex executions still running when their call returns", () => {
    const { recorder, real } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(
      codex("model.tool_call.started", 1, { payload: { callId: "call_1", name: "exec" } }),
    );
    recorder.handle(
      codex("item.started", 1.5, {
        itemId: "exec-1",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          data: { item: { type: "commandExecution" } },
        },
      }),
    );
    recorder.handle(
      codex("model.tool_call.completed", 2, { payload: { callId: "call_1", output: "ok" } }),
    );
    // Codex reports the lingering process's end later; it must not add a span.
    recorder.handle(
      codex("item.completed", 2.5, {
        itemId: "exec-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: { item: { type: "commandExecution", exitCode: 0 } },
        },
      }),
    );
    recorder.handle(codex("turn.completed", 3, { payload: { state: "completed" } }));
    assert.strictEqual(real().filter((span) => span.name.includes("command_execution")).length, 1);

    const execution = real().find((span) => span.name === "execute_tool command_execution");
    assert.strictEqual(execution!.attributes.get("t3.tool.status"), "running_when_call_returned");
    assert.isTrue(Exit.isSuccess(endExit(execution!)));
    assert.strictEqual(
      (execution!.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(2))) * 1_000_000n,
    );
  });

  it("drops a sent prompt whose turn never started", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const recorder = new AgentTelemetryRecorder({
      tracer: Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
      captureContent: true,
      staticAttributes: {},
      nowMs: () => now,
    });
    const note = (threadId: string, text: string) =>
      recorder.noteTurnInput({
        threadId,
        text,
        attachmentCount: 0,
        model: undefined,
        link: undefined,
      });
    recorder.bindTurnInput(note(THREAD, "prompt that failed to send"), TURN);
    now += 6 * 60_000;
    note("thread-2", "later prompt");
    now += 1_000;
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(event("turn.completed", 1, { payload: { state: "completed" } }));

    const agent = spans.find(
      (span) =>
        span.name.startsWith("invoke_agent") &&
        span.attributes.get("logfire.span_type") !== "pending_span",
    );
    assert.notInclude(String(agent!.attributes.get("pydantic_ai.all_messages")), "failed to send");
  });

  it("keeps a prompt first when it is bound after its turn started", () => {
    const { recorder, named } = makeRecorder();
    const note = (text: string) =>
      recorder.noteTurnInput({
        threadId: THREAD,
        text,
        attachmentCount: 0,
        model: undefined,
        link: undefined,
      });
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("item.completed", 1, {
        itemId: "text-1",
        payload: { itemType: "assistant_message", status: "completed", detail: "On it." },
      }),
    );
    // Noted after the turn started (sendTurn was slow), then a steer.
    recorder.bindTurnInput(note("Fix the gold discount"), TURN);
    recorder.bindTurnInput(note("Also add a test"), TURN);
    recorder.handle(claudeResponse(2, 1, 1, "end_turn"));
    recorder.handle(event("turn.completed", 3, { payload: { state: "completed" } }));

    const input = JSON.parse(named("chat ")[0]!.attributes.get("gen_ai.input.messages") as string);
    assert.deepStrictEqual(
      input.map((message: { parts: Array<{ content: string }> }) => message.parts[0]!.content),
      ["Fix the gold discount", "Also add a test"],
    );
  });

  it("gives a fast turn its prompt even if sendTurn returns after it finished", () => {
    const { recorder, named } = makeRecorder();
    const noteId = recorder.noteTurnInput({
      threadId: THREAD,
      text: "Quick question",
      attachmentCount: 0,
      model: undefined,
      link: undefined,
    });
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(event("turn.completed", 1, { payload: { state: "completed" } }));
    recorder.bindTurnInput(noteId, TURN);

    const agent = named("invoke_agent")[0]!;
    assert.include(String(agent.attributes.get("pydantic_ai.all_messages")), "Quick question");
  });

  it("keeps every send noted before its turn started, in order", () => {
    const { recorder, named } = makeRecorder();
    for (const text of ["First prompt", "Steer before start"]) {
      recorder.bindTurnInput(
        recorder.noteTurnInput({
          threadId: THREAD,
          text,
          attachmentCount: 0,
          model: undefined,
          link: undefined,
        }),
        TURN,
      );
    }
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(claudeResponse(1, 1, 1, "end_turn"));
    recorder.handle(event("turn.completed", 2, { payload: { state: "completed" } }));

    const input = JSON.parse(named("chat ")[0]!.attributes.get("gen_ai.input.messages") as string);
    assert.deepStrictEqual(
      input.map((message: { parts: Array<{ content: string }> }) => message.parts[0]!.content),
      ["First prompt", "Steer before start"],
    );
  });

  it("does not hand a send to a turn that was already running", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    const noteId = recorder.noteTurnInput({
      threadId: THREAD,
      text: "For the next turn",
      attachmentCount: 0,
      model: undefined,
      link: undefined,
    });
    recorder.handle(event("turn.completed", 1, { payload: { state: "completed" } }));
    recorder.bindTurnInput(noteId, "turn-2");
    recorder.handle({
      ...event("turn.started", 2, { payload: {} }),
      turnId: "turn-2",
    } as ProviderRuntimeEvent);
    recorder.handle({
      ...event("turn.completed", 3, { payload: { state: "completed" } }),
      turnId: "turn-2",
    } as ProviderRuntimeEvent);

    const [first, second] = named("invoke_agent");
    assert.notInclude(
      String(first!.attributes.get("pydantic_ai.all_messages")),
      "For the next turn",
    );
    assert.include(String(second!.attributes.get("pydantic_ai.all_messages")), "For the next turn");
  });

  it("ends a held run when its send fails instead of binding", () => {
    const { recorder, named } = makeRecorder();
    const noteId = recorder.noteTurnInput({
      threadId: THREAD,
      text: "Never bound",
      attachmentCount: 0,
      model: undefined,
      link: undefined,
    });
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(event("turn.completed", 1, { payload: { state: "completed" } }));
    // Held open while the send is unbound.
    assert.strictEqual(named("invoke_agent")[0]!.status._tag, "Started");
    assert.strictEqual(recorder.openRunCount, 1);
    recorder.abandonTurnInput(noteId);
    assert.strictEqual(recorder.openRunCount, 0);
    const [agent] = named("invoke_agent");
    assert.strictEqual(agent!.status._tag, "Ended");
    assert.notInclude(String(agent!.attributes.get("pydantic_ai.all_messages")), "Never bound");
  });

  it("labels responses after a reroute with the new model", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: { model: "model-a" } }));
    recorder.handle(
      event("model.rerouted", 1, {
        payload: { fromModel: "model-a", toModel: "model-b", reason: "capacity" },
      }),
    );
    recorder.handle(claudeResponse(2, 1, 1, "end_turn"));
    recorder.handle(event("turn.completed", 3, { payload: { state: "completed" } }));
    assert.strictEqual(named("chat ")[0]!.attributes.get("gen_ai.request.model"), "model-b");
  });

  it("nests a subagent under the Task call that is still streaming", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("item.started", 1, {
        itemId: "toolu_task",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          data: { toolName: "Task", input: {} },
        },
      }),
    );
    recorder.handle(
      event("task.started", 1.5, {
        payload: { taskId: "task-1", toolUseId: "toolu_task", taskType: "local_agent" },
      }),
    );
    recorder.handle(
      event("task.completed", 2, { payload: { taskId: "task-1", status: "completed" } }),
    );
    recorder.handle(event("turn.completed", 3, { payload: { state: "completed" } }));

    const [task] = named("execute_tool Task");
    const [subagent] = named("invoke_agent T3 Code / Claude subagent");
    assert.strictEqual(Option.getOrUndefined(subagent!.parent)?.spanId, task!.spanId);
  });

  it("skips background tasks and keeps subagent descriptions out without capture", () => {
    const { recorder, named } = makeRecorder(false);
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("task.started", 1, { payload: { taskId: "shell-1", taskType: "local_bash" } }),
    );
    recorder.handle(
      event("task.started", 1, {
        payload: { taskId: "agent-1", taskType: "local_agent", description: "Audit the auth code" },
      }),
    );
    recorder.handle(event("turn.completed", 2, { payload: { state: "completed" } }));

    const subagents = named("invoke_agent T3 Code / Claude subagent");
    assert.strictEqual(subagents.length, 1);
    assert.strictEqual(subagents[0]!.attributes.get("logfire.msg"), "subagent run");
  });

  it("ends a Codex child agent that fails through a task update", () => {
    const { recorder, named } = makeRecorder();
    const codex = (type: string, second: number, fields: Record<string, unknown> = {}) =>
      ({ ...event(type, second, fields), provider: "codex" }) as ProviderRuntimeEvent;
    recorder.handle(codex("turn.started", 0, { payload: {} }));
    recorder.handle(
      codex("task.started", 1, { payload: { taskId: "child-1", taskType: "agent" } }),
    );
    recorder.handle(
      codex("task.updated", 2, { payload: { taskId: "child-1", status: "failed", error: "boom" } }),
    );
    recorder.handle(codex("turn.completed", 3, { payload: { state: "completed" } }));

    const [child] = named("invoke_agent T3 Code / Codex subagent");
    const exit = endExit(child!);
    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(Cause.hasInterruptsOnly((exit as Exit.Failure<unknown, unknown>).cause));
    assert.strictEqual(
      (child!.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(2))) * 1_000_000n,
    );
  });

  it("lets Claude's completion close a subagent after a terminal update", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("task.started", 1, { payload: { taskId: "task-1", taskType: "local_agent" } }),
    );
    recorder.handle(
      event("task.updated", 2, { payload: { taskId: "task-1", status: "completed" } }),
    );
    recorder.handle(
      event("task.completed", 3, {
        payload: {
          taskId: "task-1",
          status: "completed",
          summary: "Found two call sites",
          typedUsage: { totalTokens: 900, inputTokens: 800, outputTokens: 100 },
        },
      }),
    );
    recorder.handle(event("turn.completed", 4, { payload: { state: "completed" } }));

    const [subagent] = named("invoke_agent T3 Code / Claude subagent");
    assert.strictEqual(subagent!.attributes.get("final_result"), "Found two call sites");
    assert.strictEqual(subagent!.attributes.get("gen_ai.aggregated_usage.input_tokens"), 800);
    assert.strictEqual(
      (subagent!.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(3))) * 1_000_000n,
    );
  });

  it("keeps a subagent running past its turn until it completes", () => {
    const { recorder, named } = makeRecorder();
    recorder.handle(event("turn.started", 0, { payload: {} }));
    recorder.handle(
      event("task.started", 1, { payload: { taskId: "bg-agent", taskType: "local_agent" } }),
    );
    recorder.handle(event("turn.completed", 2, { payload: { state: "completed" } }));
    const [subagent] = named("invoke_agent T3 Code / Claude subagent");
    assert.strictEqual(subagent!.status._tag, "Started");

    recorder.handle({
      ...event("task.completed", 9, { payload: { taskId: "bg-agent", status: "completed" } }),
      turnId: undefined,
    } as unknown as ProviderRuntimeEvent);
    assert.isTrue(Exit.isSuccess(endExit(subagent!)));
    assert.strictEqual(
      (subagent!.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>).endTime,
      BigInt(Date.parse(isoAt(9))) * 1_000_000n,
    );
  });
});
