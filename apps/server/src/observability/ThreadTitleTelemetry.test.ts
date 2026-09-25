import { describe, expect, it } from "vite-plus/test";
import * as Tracer from "effect/Tracer";
import { startThreadTitleTelemetry } from "./ThreadTitleTelemetry.ts";

describe("thread title telemetry", () => {
  function setup(captureContent: boolean) {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const recorder = startThreadTitleTelemetry({
      tracer,
      captureContent,
      nowMs: () => 1000,
      model: "gpt-6-luna",
      prompt: "Title this conversation",
      threadId: "thread-1",
      requestId: "request-1",
    });
    return { recorder, spans };
  }
  it("correlates raw and final output in an ended span", () => {
    const { recorder, spans } = setup(true);
    recorder.rawOutput('{"title":"  Fix reconnects  "}');
    recorder.finish({ title: "Fix reconnects" });
    const span = spans[0]!;
    expect(span.attributes.get("t3.thread.id")).toBe("thread-1");
    expect(span.attributes.get("t3.request.id")).toBe("request-1");
    expect(span.attributes.get("t3.title.raw_output")).toBe('{"title":"  Fix reconnects  "}');
    expect(span.attributes.get("t3.title.final")).toBe("Fix reconnects");
    expect(span.attributes.get("t3.title.prompt_sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(span.status._tag).toBe("Ended");
  });
  it("records failure without content when capture is disabled", () => {
    const { recorder, spans } = setup(false);
    recorder.rawOutput("sensitive response");
    recorder.finish(undefined);
    const span = spans[0]!;
    expect(span.attributes.get("t3.title.succeeded")).toBe(false);
    expect(span.attributes.has("t3.title.raw_output")).toBe(false);
    expect(span.attributes.has("gen_ai.input.messages")).toBe(false);
    expect(span.status._tag).toBe("Ended");
  });

  it.each(["[Earlier content truncated]", "[Content truncated]", "[truncated]"])(
    "captures the original first message separately when input uses %s",
    (marker) => {
      const spans: Array<Tracer.NativeSpan> = [];
      const recorder = startThreadTitleTelemetry({
        tracer: Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        }),
        captureContent: true,
        nowMs: () => 1000,
        model: "gpt-6-luna",
        conversation: "Implement offline search. Background label-color logs follow.",
        prompt: `User message: ${marker}\nLabelPalette color=gray`,
      });
      recorder.finish({ title: "Fix Label Colors" });
      const root = spans[0]!;
      expect(root.attributes.get("t3.title.context_truncated")).toBe(true);
      expect(JSON.parse(String(root.attributes.get("t3.title.source_messages")))).toEqual([
        {
          index: 0,
          role: "user",
          text: "Implement offline search. Background label-color logs follow.",
        },
      ]);
      expect(root.attributes.get("gen_ai.input.messages")).not.toContain(
        "Implement offline search",
      );
    },
  );
  it("redacts credentials and tolerates exporter failures", () => {
    const { recorder, spans } = setup(true);
    recorder.rawOutput("password=hunter2 sk-abcdefghijklmnop");
    recorder.finish({ title: "Fix login errors" });
    expect(spans[0]!.attributes.get("t3.title.raw_output")).not.toContain("hunter2");
    expect(spans[0]!.attributes.get("t3.title.raw_output")).not.toContain("sk-abcdefghijklmnop");
    const broken = startThreadTitleTelemetry({
      tracer: Tracer.make({
        span: () => {
          throw new Error("offline");
        },
      }),
      captureContent: true,
      nowMs: () => 1000,
      model: "luna",
      prompt: "hello",
    });
    expect(() => {
      broken.rawOutput("response");
      broken.finish(undefined);
    }).not.toThrow();
  });

  it("records real tool children and aggregate provider usage without inventing model requests", () => {
    const { recorder, spans } = setup(true);
    recorder.providerStarted({ model: "gpt-6-luna", reasoningEffort: "low" });
    const item = {
      id: "tool-1",
      type: "mcp_tool_call",
      server: "logfire",
      tool: "query_run",
      arguments: { password: "secret", query: "SELECT 1" },
    };
    recorder.event(JSON.stringify({ type: "item.started", item }));
    recorder.event(
      JSON.stringify({
        type: "item.completed",
        item: { ...item, status: "completed", result: { rows: [1] } },
      }),
    );
    recorder.event(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 24000, cached_input_tokens: 20000, output_tokens: 42 },
      }),
    );
    recorder.rawOutput('{"title":"Inspect query results"}');
    recorder.finish({ title: "Inspect query results" });
    expect(spans.map((span) => span.name)).toEqual([
      "generate thread title",
      "invoke_agent codex.title",
      "execute_tool logfire.query_run",
    ]);
    expect(spans[1]!.parent).toEqual(expect.objectContaining({ value: spans[0] }));
    expect(spans[2]!.parent).toEqual(expect.objectContaining({ value: spans[1] }));
    expect(spans[1]!.attributes.get("gen_ai.aggregated_usage.input_tokens")).toBe(24000);
    expect(spans[0]!.attributes.get("t3.title.provider_events_complete")).toBe(true);
    expect(spans[0]!.attributes.get("t3.title.tool_count")).toBe(1);
    expect(JSON.parse(String(spans[2]!.attributes.get("gen_ai.tool.call.arguments")))).toEqual({
      password: "[redacted]",
      query: "SELECT 1",
    });
    expect(JSON.parse(String(spans[1]!.attributes.get("gen_ai.input.messages")))[0].role).toBe(
      "user",
    );
    expect(spans.every((span) => span.status._tag === "Ended")).toBe(true);
  });

  it("keeps an interrupted or unparseable event stream distinguishable from a successful tool-free run", () => {
    const { recorder, spans } = setup(false);
    recorder.providerStarted({ model: "gpt-6-luna", reasoningEffort: "low" });
    recorder.event("not json");
    recorder.event(
      JSON.stringify({
        type: "item.started",
        item: { id: "tool-1", type: "command_execution", command: "private command" },
      }),
    );
    recorder.event(
      JSON.stringify({
        type: "item.completed",
        item: { id: "reason-1", type: "reasoning", text: "private reasoning" },
      }),
    );
    recorder.finish(undefined);
    recorder.finish(undefined);
    expect(spans).toHaveLength(3);
    expect(spans[0]!.attributes.get("t3.title.provider_events_complete")).toBe(false);
    expect(spans[0]!.attributes.get("t3.title.event_decode_errors")).toBe(1);
    expect(spans[2]!.attributes.get("error.type")).toBe("IncompleteToolExecution");
    expect(spans[2]!.attributes.has("gen_ai.tool.call.arguments")).toBe(false);
    expect(spans.every((span) => span.status._tag === "Ended")).toBe(true);
  });

  it("keeps source history separate from supplied input and gates it on content capture", () => {
    for (const captureContent of [false, true]) {
      const spans: Array<Tracer.NativeSpan> = [];
      const recorder = startThreadTitleTelemetry({
        tracer: Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        }),
        captureContent,
        model: "luna",
        nowMs: () => 1000,
        prompt: "Only the latest message",
        context: {
          sourceMessageCount: 2,
          retainedMessageCount: 1,
          droppedMessageIndices: [0],
          truncatedMessageIndices: [],
          sourceMessages: [
            { index: 0, role: "user", text: "password=secret Switch to CSV export cancellation" },
            { index: 1, role: "user", text: "Run tests" },
          ],
        },
      });
      recorder.finish({ title: "Run tests" });
      expect(spans[0]!.attributes.get("t3.title.dropped_message_indices")).toEqual([0]);
      const source = spans[0]!.attributes.get("t3.title.source_messages");
      if (captureContent) {
        expect(JSON.parse(String(source))[0].text).toBe(
          "password=[redacted] Switch to CSV export cancellation",
        );
        expect(String(spans[0]!.attributes.get("gen_ai.input.messages"))).not.toContain("CSV");
      } else expect(source).toBeUndefined();
    }
  });
});
