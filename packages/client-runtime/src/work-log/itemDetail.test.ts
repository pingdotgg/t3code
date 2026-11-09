import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isJsonToolText, turnItemOutputImages, turnItemOutputText } from "./itemDetail.ts";

describe("isJsonToolText", () => {
  it.each([
    ['{"screenshot":{"mimeType":"image/png"}}', true],
    ['[{"threadId":"thread-1"}]', true],
    ['{\n\n  "status": "completed"\n}', true],
    ['{\n  "count": 1\n}\n\n{\n  "count": 2\n}', true],
    ["false", true],
    ["null", true],
    ["42", true],
    ['"completed"', true],
    ['{"partial":', false],
    ['{"count":1}\n\nFinished.', false],
    ["No output.", false],
    ["", false],
  ] as const)("classifies %j as JSON: %s", (text, expected) => {
    expect(isJsonToolText(text)).toBe(expected);
  });
});

function toolItem(output: unknown): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("images"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName: "screenshots",
    input: {},
    output,
  };
}

describe("tool image output parsing", () => {
  it.each(["image-only", "summary", "json"] as const)(
    "keeps structured fields beside %s content",
    (shape) => {
      const content = [
        { type: "image", mimeType: "image/png" },
        ...(shape === "image-only"
          ? []
          : [{ type: "text", text: shape === "summary" ? "Sunny" : '{"temp":21}' }]),
      ];
      for (const structuredContent of [
        { temp: 21 },
        { type: "text", text: "Sunny", temp: 21 },
        { content: [{ type: "text", text: "Sunny" }], temp: 21 },
      ]) {
        const item = toolItem({ structuredContent, content });
        expect(turnItemOutputText(item)).toBe(JSON.stringify(structuredContent, null, 2));
        expect(turnItemOutputImages(item)).toHaveLength(1);
      }
      for (const structuredContent of [null, {}, [], ""]) {
        const item = toolItem({ structuredContent, content: [{ type: "text", text: "Sunny" }] });
        expect(turnItemOutputText(item)).toBe("Sunny");
      }
      expect(
        turnItemOutputText(
          toolItem({
            content: [{ type: "text", text: "File contents" }],
            structuredContent: { path: "read.ts", ready: true },
          }),
        ),
      ).toBe("File contents");
    },
  );
  it.each(["array", "content", "structured"] as const)(
    "keeps markers for images beyond the served positions in %s output",
    (shape) => {
      // Detail responses retain image metadata after the server strips image bytes.
      const image = { type: "image", mimeType: "image/png" };
      const blocks = Array.from({ length: 8 }, () => ({ ...image }));
      const wrap = (content: unknown[]) =>
        shape === "array"
          ? content
          : shape === "structured"
            ? { content, structuredContent: { temp: 21 } }
            : { content };
      const withinLimit = toolItem(wrap(blocks));
      expect(turnItemOutputText(withinLimit)).toBe(
        shape === "structured" ? '{\n  "temp": 21\n}' : null,
      );
      expect(turnItemOutputImages(withinLimit)).toHaveLength(8);

      const overflow = toolItem(
        wrap([
          ...blocks,
          { type: "text", text: "Two additional screenshots:" },
          { ...image, sizeBytes: 100 },
          { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
        ]),
      );
      expect(turnItemOutputImages(overflow)).toHaveLength(8);
      expect(turnItemOutputText(overflow)).toBe(
        (shape === "structured" ? '{\n  "temp": 21\n}' : "Two additional screenshots:") +
          "\n[image]\n[image]",
      );
    },
  );
});

describe("MCP app tool output", () => {
  it("shows the tool result, not the app wrapper", () => {
    const text = "Notice\nview\tcount\n/home\t42";
    const item = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "aggregate_rum_events",
        resourceUri: "ui://repro/dataviz",
      },
      result: { content: [{ type: "text", text }] },
    });
    expect(turnItemOutputText(item)).toBe(text);
  });

  it("reads a result with metadata and marks images it cannot preview", () => {
    const item = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "chart",
        resourceUri: "ui://repro/chart",
      },
      result: {
        content: [
          { type: "text", text: "chart" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
        _meta: { "ui/resourceUri": "ui://repro/chart" },
      },
    });
    expect(turnItemOutputText(item)).toBe("chart\n[image]");
  });
});
