import { describe, expect, it } from "vite-plus/test";

import { isTempArtifactPath, publishedArtifactsFromTurnItems } from "./publishedArtifacts.ts";

describe("publishedArtifactsFromTurnItems", () => {
  it("extracts Claude Artifact publishes from structured results", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "dynamic_tool",
        toolName: "Artifact",
        input: { file_path: "/tmp/page.html", label: "Demo" },
        output: {
          type: "structured_tool_use_result",
          value: {
            url: "https://claude.ai/artifact/abc123",
            path: "/tmp/page.html",
            title: "Demo page",
          },
        },
      },
      {
        id: "item-2",
        type: "dynamic_tool",
        toolName: "ArtifactComments",
        output: { url: "https://claude.ai/artifact/ignored" },
      },
    ]);

    expect(artifacts).toEqual([
      {
        id: "claude-artifact:https://claude.ai/artifact/abc123",
        kind: "claude-artifact",
        title: "Demo page",
        url: "https://claude.ai/artifact/abc123",
        path: "/tmp/page.html",
        htmlRender: null,
        toolName: "Artifact",
        itemId: "item-1",
      },
    ]);
  });

  it("extracts Claude Artifact URLs from Published at text", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "dynamic_tool",
        toolName: "artifact",
        output: "Published at https://claude.ai/code/artifact/xyz",
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.url).toBe("https://claude.ai/code/artifact/xyz");
    expect(artifacts[0]?.kind).toBe("claude-artifact");
  });

  it("extracts html_render references", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "dynamic_tool",
        toolName: "mcp__t3-code__html_render",
        output: {
          htmlRender: {
            attachmentId: "att-1",
            title: "Chart",
            height: 400,
          },
        },
      },
    ]);

    expect(artifacts).toEqual([
      {
        id: "html-render:att-1",
        kind: "html-render",
        title: "Chart",
        url: null,
        path: null,
        htmlRender: { attachmentId: "att-1", title: "Chart", height: 400 },
        toolName: "mcp__t3-code__html_render",
        itemId: "item-1",
      },
    ]);
  });

  it("dedupes republishes of the same Claude artifact URL", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "dynamic_tool",
        toolName: "Artifact",
        output: { url: "https://claude.ai/artifact/same", title: "First" },
      },
      {
        id: "item-2",
        type: "dynamic_tool",
        toolName: "Artifact",
        output: { url: "https://claude.ai/artifact/same", title: "Updated" },
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.title).toBe("Updated");
    expect(artifacts[0]?.itemId).toBe("item-2");
  });

  it("classifies common OS temp paths", () => {
    expect(isTempArtifactPath("/tmp/page.html")).toBe(true);
    expect(isTempArtifactPath("/private/var/folders/xx/yy/T/scratch.md")).toBe(true);
    expect(isTempArtifactPath("C:\\Users\\a\\AppData\\Local\\Temp\\out.html")).toBe(true);
    expect(isTempArtifactPath("src/app.ts")).toBe(false);
    expect(isTempArtifactPath("/Users/a/project/src/app.ts")).toBe(false);
  });

  it("extracts temp file writes from file_change items", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "file_change",
        fileName: "/tmp/report.html",
        changes: [{ operation: "create", path: "/tmp/report.html" }],
      },
      {
        id: "item-2",
        type: "file_change",
        fileName: "src/app.ts",
        changes: [{ operation: "update", path: "src/app.ts" }],
      },
      {
        id: "item-3",
        type: "file_change",
        fileName: "/tmp/gone.html",
        changes: [{ operation: "delete", path: "/tmp/gone.html" }],
      },
    ]);

    expect(artifacts).toEqual([
      {
        id: "temp-file:/tmp/report.html",
        kind: "temp-file",
        title: "report.html",
        url: null,
        path: "/tmp/report.html",
        htmlRender: null,
        toolName: null,
        itemId: "item-1",
      },
    ]);
  });

  it("extracts temp paths from Write-like dynamic tools", () => {
    const artifacts = publishedArtifactsFromTurnItems([
      {
        id: "item-1",
        type: "dynamic_tool",
        toolName: "Write",
        input: { file_path: "/tmp/notes.md", content: "hi" },
      },
      {
        id: "item-2",
        type: "dynamic_tool",
        toolName: "Write",
        input: { file_path: "README.md", content: "hi" },
      },
    ]);

    expect(artifacts).toEqual([
      {
        id: "temp-file:/tmp/notes.md",
        kind: "temp-file",
        title: "notes.md",
        url: null,
        path: "/tmp/notes.md",
        htmlRender: null,
        toolName: "Write",
        itemId: "item-1",
      },
    ]);
  });
});
