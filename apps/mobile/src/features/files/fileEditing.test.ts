import type { ProjectReadFileResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canEditWorkspaceFile,
  fromEditorText,
  MAX_EDITABLE_FILE_BYTES,
  toEditorText,
} from "./fileEditing";

function readResult(overrides: Partial<ProjectReadFileResult> = {}): ProjectReadFileResult {
  return {
    relativePath: "src/main.ts",
    contents: "const main = 1;\n",
    byteLength: 16,
    truncated: false,
    revision: "revision-1",
    ...overrides,
  };
}

function canEdit(relativePath: string, file: ProjectReadFileResult | null = readResult()): boolean {
  return canEditWorkspaceFile({ relativePath, file });
}

describe("editor text line endings", () => {
  it("leaves an LF file unchanged", () => {
    expect(toEditorText("one\ntwo\n")).toEqual({
      text: "one\ntwo\n",
      lineEnding: "\n",
      hasUtf8Bom: false,
    });
    expect(fromEditorText("one\ntwo\n", "\n")).toBe("one\ntwo\n");
  });

  it("round-trips a CRLF file byte-identical", () => {
    const contents = "one\r\ntwo\r\n";
    const editor = toEditorText(contents);

    expect(editor).toEqual({ text: "one\ntwo\n", lineEnding: "\r\n", hasUtf8Bom: false });
    expect(fromEditorText(editor.text, editor.lineEnding)).toBe(contents);
  });

  it("keeps a missing trailing newline missing", () => {
    const contents = "one\r\ntwo";
    const editor = toEditorText(contents);

    expect(fromEditorText(editor.text, editor.lineEnding)).toBe(contents);
    expect(toEditorText("one\ntwo").text).toBe("one\ntwo");
  });

  it("keeps the UTF-8 BOM outside the editable text and restores it with CRLF", () => {
    const contents = "\uFEFFone\r\ntwo\r\n";
    const editor = toEditorText(contents);

    expect(editor.text).toBe("one\ntwo\n");
    expect(editor.hasUtf8Bom).toBe(true);
    expect(fromEditorText(editor.text, editor.lineEnding, editor.hasUtf8Bom)).toBe(contents);
    expect(fromEditorText("edited\n", editor.lineEnding, editor.hasUtf8Bom)).toBe(
      "\uFEFFedited\r\n",
    );
  });

  it("does not double the CR of a CRLF the editor already holds", () => {
    expect(fromEditorText("one\r\ntwo\n", "\r\n")).toBe("one\r\ntwo\r\n");
  });
});

describe("canEditWorkspaceFile", () => {
  it("accepts loaded source and Markdown files", () => {
    expect(canEdit("src/main.ts")).toBe(true);
    expect(canEdit("docs/readme.md")).toBe(true);
    expect(canEdit("assets/page.html")).toBe(true);
  });

  it("rejects a file outside the workspace", () => {
    expect(canEdit("/tmp/report.md")).toBe(false);
    expect(canEdit("C:\\repo\\main.ts")).toBe(false);
  });

  it("rejects a read the server could not complete", () => {
    expect(canEdit("src/main.ts", null)).toBe(false);
    expect(canEdit("src/main.ts", readResult({ truncated: true }))).toBe(false);
    const { revision: _revision, ...withoutRevision } = readResult();
    expect(canEdit("src/main.ts", withoutRevision)).toBe(false);
  });

  it("rejects a file past the editable size cap", () => {
    expect(canEdit("src/main.ts", readResult({ byteLength: MAX_EDITABLE_FILE_BYTES }))).toBe(true);
    expect(canEdit("src/main.ts", readResult({ byteLength: MAX_EDITABLE_FILE_BYTES + 1 }))).toBe(
      false,
    );
  });

  it("rejects preview formats", () => {
    expect(canEdit("assets/photo.png")).toBe(false);
    expect(canEdit("assets/diagram.svg")).toBe(false);
    expect(canEdit("docs/report.pdf")).toBe(false);
    expect(canEdit("assets/clip.mp4")).toBe(false);
    expect(canEdit("assets/voice.m4a")).toBe(false);
  });
});
