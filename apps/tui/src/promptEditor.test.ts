import { describe, expect, it } from "bun:test";

import { normalizeEditedPrompt, resolveEditorCommand } from "./promptEditor.ts";

describe("resolveEditorCommand", () => {
  it("Given VISUAL, then it wins over EDITOR and splits into command + args", () => {
    expect(resolveEditorCommand({ VISUAL: "code --wait", EDITOR: "vim" })).toEqual({
      cmd: "code",
      args: ["--wait"],
    });
  });

  it("Given only EDITOR, then it is used", () => {
    expect(resolveEditorCommand({ EDITOR: "vim -u NONE" })).toEqual({
      cmd: "vim",
      args: ["-u", "NONE"],
    });
  });

  it("Given neither, then it falls back to vi", () => {
    expect(resolveEditorCommand({})).toEqual({ cmd: "vi", args: [] });
  });

  it("Given a blank value, then it still falls back to vi", () => {
    expect(resolveEditorCommand({ EDITOR: "   " })).toEqual({ cmd: "vi", args: [] });
  });
});

describe("normalizeEditedPrompt", () => {
  it("converts CRLF to LF and trims the trailing newline editors append", () => {
    expect(normalizeEditedPrompt("line one\r\nline two\n")).toBe("line one\nline two");
  });

  it("keeps interior blank lines but drops only trailing ones", () => {
    expect(normalizeEditedPrompt("a\n\nb\n\n\n")).toBe("a\n\nb");
  });

  it("Given empty content, then it returns an empty string", () => {
    expect(normalizeEditedPrompt("\n\n")).toBe("");
  });
});
