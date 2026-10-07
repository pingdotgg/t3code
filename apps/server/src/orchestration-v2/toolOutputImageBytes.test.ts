import { NodeId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  MAX_TOOL_OUTPUT_IMAGES,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";

const PNG_BYTES = 3_000;
const PNG_BASE64 = Buffer.alloc(PNG_BYTES, 7).toString("base64");
// 3,001 bytes encode with `=` padding, which must not count as data.
const PADDED_BASE64 = Buffer.alloc(PNG_BYTES + 1, 9).toString("base64");

const now = DateTime.makeUnsafe("2026-10-06T00:00:00.000Z");

const itemBase = {
  id: TurnItemId.make("turn-item:tool"),
  threadId: ThreadId.make("thread:tool"),
  runId: null,
  nodeId: NodeId.make("node:tool"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

function toolItem(output: unknown, toolName = "Read"): OrchestrationV2TurnItem {
  return {
    ...itemBase,
    type: "dynamic_tool",
    toolName,
    input: { file_path: "/tmp/shot.png" },
    output,
  };
}

function outputOf(item: OrchestrationV2TurnItem): unknown {
  return item.type === "dynamic_tool" ? item.output : undefined;
}

describe("stripUnservedToolOutputImageBytes", () => {
  it("replaces the base64 of Claude's structured Read result with its measured size", () => {
    const item = toolItem({
      type: "image",
      file: {
        base64: PNG_BASE64,
        type: "image/png",
        originalSize: PNG_BYTES,
        dimensions: { originalWidth: 180, originalHeight: 180 },
      },
    });

    expect(outputOf(stripUnservedToolOutputImageBytes(item))).toEqual({
      type: "image",
      file: {
        type: "image/png",
        originalSize: PNG_BYTES,
        dimensions: { originalWidth: 180, originalHeight: 180 },
        sizeBytes: PNG_BYTES,
      },
    });
  });

  it("strips ACP image shapes: Grok's native ImageContent and an MCP result behind an error", () => {
    const item = toolItem({
      rawOutput: { type: "ReadFile", ImageContent: { data: PNG_BASE64, mime_type: "image/png" } },
      failed: {
        error: "partial result",
        result: [{ type: "image", data: PADDED_BASE64, mimeType: "image/png" }],
      },
    });

    expect(outputOf(stripUnservedToolOutputImageBytes(item))).toEqual({
      rawOutput: {
        type: "ReadFile",
        ImageContent: { mime_type: "image/png", sizeBytes: PNG_BYTES },
      },
      failed: {
        error: "partial result",
        result: [{ type: "image", mimeType: "image/png", sizeBytes: PNG_BYTES + 1 }],
      },
    });
  });

  it("strips a Cursor image part that names no mime type", () => {
    const item = toolItem({
      content: [{ text: { text: "captured" } }, { image: { data: PNG_BASE64 } }],
    });

    expect(outputOf(stripUnservedToolOutputImageBytes(item))).toEqual({
      content: [{ text: { text: "captured" } }, { image: { sizeBytes: PNG_BYTES } }],
    });
  });

  it("keeps the screenshots a tool-output-image asset serves", () => {
    const claudeImage = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
    };
    const mcpImage = { type: "image", data: PADDED_BASE64, mimeType: "image/jpeg" };
    const item = toolItem(
      { content: [{ type: "text", text: "captured" }, claudeImage, mcpImage] },
      "mcp__t3-code__device_screenshot",
    );

    const stripped = stripUnservedToolOutputImageBytes(item);

    expect(stripped).toBe(item);
    expect(toolOutputImages(outputOf(stripped))).toEqual([
      { mimeType: "image/png", data: PNG_BASE64 },
      { mimeType: "image/jpeg", data: PADDED_BASE64 },
    ]);
  });

  it("strips only the images past the last one an asset can serve", () => {
    const images = Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 2 }, () => ({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    }));

    const output = outputOf(stripUnservedToolOutputImageBytes(toolItem(images)));

    expect(Array.isArray(output) ? output.slice(0, MAX_TOOL_OUTPUT_IMAGES) : null).toEqual(
      images.slice(0, MAX_TOOL_OUTPUT_IMAGES),
    );
    expect(Array.isArray(output) ? output.slice(MAX_TOOL_OUTPUT_IMAGES) : null).toEqual([
      { type: "image", mimeType: "image/png", sizeBytes: PNG_BYTES },
      { type: "image", mimeType: "image/png", sizeBytes: PNG_BYTES },
    ]);
  });

  it("strips a served-position image larger than an asset may serve", () => {
    const oversized = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
    const servable = { type: "image", data: PNG_BASE64, mimeType: "image/png" };
    const item = toolItem({
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: oversized } },
        servable,
      ],
    });

    const output = outputOf(stripUnservedToolOutputImageBytes(item)) as {
      content: ReadonlyArray<unknown>;
    };

    expect(output.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          sizeBytes: ((MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4) / 4) * 3,
        },
      },
      servable,
    ]);
    expect(output.content[1]).toBe(servable);
  });

  it("keeps image fields whose value is not a base64 body", () => {
    const item = toolItem({
      nested: {
        byId: { type: "image", data: "asset-id-42" },
        svg: {
          mimeType: "image/svg+xml",
          data: `<svg xmlns='http://www.w3.org/2000/svg'>${"<circle r='4'/>".repeat(8)}</svg>`,
        },
        dataUrl: { type: "image", data: `data:image/png;base64,${PNG_BASE64}` },
        remote: { type: "image", source: { type: "url", url: "https://example.test/shot.png" } },
        tiny: { type: "image", data: "AA==", mimeType: "image/png" },
        notImage: { mimeType: "application/pdf", data: PNG_BASE64 },
      },
    });

    expect(stripUnservedToolOutputImageBytes(item)).toBe(item);
  });

  it("measures the size instead of trusting one the provider supplied", () => {
    const item = toolItem({
      type: "image",
      file: { base64: PNG_BASE64, type: "image/png", sizeBytes: 0 },
    });

    expect(outputOf(stripUnservedToolOutputImageBytes(item))).toEqual({
      type: "image",
      file: { type: "image/png", sizeBytes: PNG_BYTES },
    });
  });

  it("returns items without image bytes by reference", () => {
    const nested = { files: [{ path: "src/app.ts" }] };
    const item = toolItem({ stdout: "data: 42", data: PNG_BASE64, nested });
    const command: OrchestrationV2TurnItem = {
      ...itemBase,
      type: "command_execution",
      input: "cat shot.png | base64",
      output: PNG_BASE64,
    };

    const stripped = stripUnservedToolOutputImageBytes(item);

    expect(stripped).toBe(item);
    expect(outputOf(stripped)).toBe(outputOf(item));
    expect(stripUnservedToolOutputImageBytes(command)).toBe(command);
    expect(stripUnservedToolOutputImageBytes(toolItem("plain text output"))).toEqual(
      toolItem("plain text output"),
    );
  });

  it("does not mutate the provider's item and shares untouched siblings", () => {
    const untouched = { type: "text", text: "captured" };
    const output = {
      error: "partial result",
      result: [untouched, { type: "image", data: PNG_BASE64, mimeType: "image/png" }],
    };
    const item = toolItem(output);
    const snapshot = structuredClone(output);

    const stripped = outputOf(stripUnservedToolOutputImageBytes(item)) as typeof output;

    expect(outputOf(item)).toEqual(snapshot);
    expect(stripped.result[0]).toBe(untouched);
  });
});
