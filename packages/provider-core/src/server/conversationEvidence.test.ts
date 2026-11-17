import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { summaryToolText } from "./conversationEvidence.ts";

function toolItem(output: unknown): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("image-read"),
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
    toolName: "Read",
    input: { file_path: "/home/user/screenshot.png" },
    output,
  };
}

const attachmentBytes = "AAECAwQ=";
const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(20_000) + "AA==";
const encodedScript = Buffer.from(
  "#!/usr/bin/env python3\n" + "print('keep port 8421')\n".repeat(200),
).toString("base64");
const encodedPatch = Buffer.from("diff --git a/app.ts b/app.ts\n+const port = 8421;\n".repeat(80))
  .toString("base64")
  .match(/.{1,76}/g)!
  .join("\n");
const sourceMap = Buffer.from(
  JSON.stringify({ version: 3, sources: ["src/app.ts"], mappings: "AAAA;AACA" }),
).toString("base64");

function evidenceOutput(output: unknown): unknown {
  return JSON.parse(summaryToolText(toolItem(output))!).output;
}

describe("summaryToolText", () => {
  it.each([
    [
      "Claude screenshot without MIME",
      { type: "image", source: { type: "base64", data: attachmentBytes } },
    ],
    ["MCP image", { type: "image", mimeType: "image/png", data: attachmentBytes }],
    ["MCP audio", { type: "audio", mimeType: "audio/wav", data: attachmentBytes }],
    [
      "MCP resource",
      {
        type: "resource",
        resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: attachmentBytes },
      },
    ],
    [
      "Codex input image",
      { type: "input_image", image_url: `data:image/png;base64,${attachmentBytes}` },
    ],
    [
      "OpenAI input audio",
      { type: "input_audio", input_audio: { data: attachmentBytes, format: "wav" } },
    ],
    [
      "OpenAI input file",
      { type: "input_file", filename: "report.pdf", file_data: attachmentBytes },
    ],
    ["Gemini inline data", { inlineData: { mimeType: "image/png", data: attachmentBytes } }],
    ["encoded source", { encoding: "base64", data: attachmentBytes }],
    ["serialized Buffer", { type: "Buffer", data: [1, 2, 3, 255] }],
    [
      "percent-encoded image",
      { type: "input_image", image_url: "data:image/png,%89PNG%0D%0A%1A%0A" },
    ],
    ["explicitly encoded text", { type: "base64", mimeType: "text/plain", data: attachmentBytes }],
  ])("excludes %s bytes while retaining neighboring text and metadata", (_name, block) => {
    const output = { content: [{ type: "text", text: "The screenshot was captured." }, block] };
    const before = JSON.stringify(output);
    const evidence = summaryToolText(toolItem(output))!;
    expect(evidence).not.toContain(attachmentBytes);
    expect(evidence).not.toContain("255");
    expect(evidence).toContain("[binary payload omitted]");
    expect(evidence).toContain("The screenshot was captured.");
    expect(evidence).toContain("/home/user/screenshot.png");
    expect(JSON.stringify(output)).toBe(before);
    expect(evidence.length).toBeLessThan(1_000);
  });

  it("reduces a large nested screenshot to metadata without losing structured tool results", () => {
    const output = {
      t3McpApp: { attachmentId: "chart", resourceUri: "ui://acme/chart" },
      result: {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: bytes } },
        ],
        structuredContent: { chartId: "123", rows: 42 },
      },
    };
    const evidence = summaryToolText(toolItem(output))!;
    expect(evidence).not.toContain(bytes);
    expect(evidence).toContain("image/png");
    expect(evidence).toContain("ui://acme/chart");
    expect(evidence).toContain('"rows": 42');
    expect(evidence.length).toBeLessThan(1_000);
    expect(evidenceOutput(evidenceOutput(output))).toEqual(evidenceOutput(output));
  });

  it("sanitizes nested stringified tool results without rounding JSON numbers", () => {
    const output = `{"id":9007199254740993,"huge":1e309,"result":${JSON.stringify(JSON.stringify({ content: [{ type: "image", data: bytes }], message: "Saved screenshot" }))}}`;
    const evidence = evidenceOutput(output) as string;
    expect(evidence).not.toContain(bytes);
    expect(evidence).toContain("9007199254740993");
    expect(evidence).toContain("1e309");
    expect(evidence).toContain("Saved screenshot");
    expect(evidence.length).toBeLessThan(300);
  });

  it("preserves ordinary data fields, resource text, code, numbers, and attachment references", () => {
    const output = {
      data: "ordinary data",
      declaration: "const metadata:Value, input:unknown;",
      javascriptTemplate: "await import(`data:text/javascript,${encodeURIComponent(source)}`)",
      textUrl: "data:text/plain,Keep%20port%208421.",
      scriptUrl: "data:text/javascript,export%20default%2042",
      sourceMapUrl: `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${sourceMap}`,
      imageFixture: 'await expect(load("data:image/png;base64,AAAA")).rejects.toThrow();',
      contents: { "scripts/check.py": { base64: encodedScript } },
      patchMessage: `Apply this patch:\n${encodedPatch}\nthen run tests.`,
      jsonData: { mimeType: "application/json", data: { answer: 42 } },
      jsonRows: { mimeType: "application/json", data: [1, 2, 3] },
      textFile: { type: "file", mimeType: "text/plain", data: "Keep port 8421." },
      parsedData: { mimeType: "application/octet-stream", data: { answer: 42 } },
      values: [1, 2, 3],
      content: [
        {
          type: "resource",
          resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "Use port 8421." },
        },
        {
          type: "resource_link",
          uri: "t3-context://image/123",
          name: "diagram.png",
          mimeType: "image/png",
        },
        { type: "text", text: 'const data = { value: "kept" };' },
      ],
    };
    expect(evidenceOutput(output)).toEqual(output);
  });

  it("removes inline data URLs and long encoded runs from command text", () => {
    const urlBytes = Buffer.from(Array.from({ length: 6_000 }, (_, index) => index % 256)).toString(
      "base64url",
    );
    expect(evidenceOutput(urlBytes)).toBe("[binary payload omitted]");
    const wrapped = bytes.match(/.{1,76}/g)!.join("\n");
    const output = `Before ![diagram](data:image/png;base64,${bytes}) after\nEncoded: ${bytes}\n${wrapped}\nNext step: run tests.`;
    const evidence = evidenceOutput(output) as string;
    expect(evidence).not.toContain(bytes);
    expect(evidence).toContain("Before");
    expect(evidence).toContain("after");
    expect(evidence).toContain("Next step: run tests.");
    expect(evidence.length).toBeLessThan(200);
  });

  it("omits raw binary strings while preserving ANSI logs and ordinary long text", () => {
    expect(evidenceOutput("\0\u0001\u0002\u0003".repeat(300))).toBe("[binary payload omitted]");
    const block = "\0\u0001\u0002\u0003".repeat(150);
    expect(
      evidenceOutput(`$ sqlite3 /tmp/state.db .dump\n${block}\n\uFFFD\uFFFDx\n${block}\nexit 0`),
    ).toBe("$ sqlite3 /tmp/state.db .dump\n[binary payload omitted]\nexit 0");
    const prefix = "Readable log line.\n".repeat(600);
    expect(evidenceOutput(`${prefix}${block}\nexit 0`)).toBe(
      `${prefix}[binary payload omitted]\nexit 0`,
    );
    expect(evidenceOutput(`warning: bell\u0007 retained\n${block}\nexit 0`)).toBe(
      "warning: bell\u0007 retained\n[binary payload omitted]\nexit 0",
    );
    const log = "\u001b[32mPASSED\u001b[0m\n".repeat(300);
    expect(evidenceOutput(log)).toBe(log);
    expect(evidenceOutput("x".repeat(10_000))).toBe("x".repeat(10_000));
  });

  it("preserves oversized prose, JSON arrays, and long identifiers", () => {
    const prose = "[INFO] " + "Keep ordinary evidence. ".repeat(400_000);
    expect(evidenceOutput(prose)).toBe(prose);
    const entries = Array.from({ length: 25_000 }, (_, index) => ({ data: `entry ${index}` }));
    expect(evidenceOutput(entries)).toEqual(entries);
    const json = JSON.stringify(entries);
    expect(evidenceOutput(json)).toBe(json);
    const identifier = `const ${"LongIdentifier123".repeat(1_000)} = true;`;
    expect(evidenceOutput(identifier)).toBe(identifier);
  });

  it("sanitizes deeply nested payloads and large fanout without dropping entries", () => {
    let output: unknown = { type: "image", data: bytes };
    for (let index = 0; index < 100; index++) output = { result: output };
    const deep = summaryToolText(toolItem(output))!;
    expect(deep).not.toContain(bytes);
    expect(deep).toContain("[binary payload omitted]");
    const wide = summaryToolText(
      toolItem(Array.from({ length: 100_000 }, () => ({ type: "image", data: bytes }))),
    )!;
    expect(JSON.parse(wide).output).toHaveLength(100_000);
    expect(wide).not.toContain(bytes);
  });
});
