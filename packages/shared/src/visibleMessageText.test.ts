import { describe, expect, it } from "vite-plus/test";

import { deriveDisplayedUserMessageContent } from "./visibleMessageText.ts";

describe("deriveDisplayedUserMessageContent", () => {
  it("extracts context blocks before trailing preview annotations", () => {
    const text = [
      "Fix this",
      "",
      "<terminal_context>",
      "- Terminal 1 line 12:",
      "  12 | failing output",
      "</terminal_context>",
      "",
      "<element_context>",
      "- <button>:",
      "  selector: .submit",
      "</element_context>",
      "",
      "<preview_annotation>",
      "Preview annotation:",
      "Id: annotation_1",
      "Page: Example",
      "</preview_annotation>",
    ].join("\n");

    expect(deriveDisplayedUserMessageContent(text)).toMatchObject({
      visibleText: "Fix this",
      copyText: text,
      terminalContexts: [{ header: "Terminal 1 line 12", body: "12 | failing output" }],
      elementContexts: [{ header: "<button>", body: "selector: .submit" }],
      previewAnnotations: [{ id: "annotation_1", title: "Example" }],
    });
  });

  const terminal = "<terminal_context>\n- Terminal 1 line 12:\n  12 | output\n</terminal_context>";
  const element = "<element_context>\n- <button>:\n  selector: .submit\n</element_context>";
  const preview = "<preview_annotation>\nId: annotation_1\nPage: Example\n</preview_annotation>";

  it.each([
    [preview, terminal, element],
    [preview, element, terminal],
    [terminal, preview, element],
    [element, preview, terminal],
    [terminal, element, preview],
    [element, terminal, preview],
  ])("extracts mixed suffixes in order %#", (...suffixes) => {
    const text = ["Fix this", ...suffixes].join("\n\n");
    expect(deriveDisplayedUserMessageContent(text)).toMatchObject({
      visibleText: "Fix this",
      copyText: text,
      terminalContexts: [{ header: "Terminal 1 line 12", body: "12 | output" }],
      elementContexts: [{ header: "<button>", body: "selector: .submit" }],
      previewAnnotations: [{ id: "annotation_1", title: "Example" }],
    });
  });

  it("keeps annotation-owned element context inside the attachment", () => {
    const nestedPreview = preview.replace(
      "</preview_annotation>",
      "<element_context>\n- <input>:\n  selector: .inside-preview\n</element_context>\n</preview_annotation>",
    );
    const text = ["Fix this", nestedPreview, terminal, element].join("\n\n");
    expect(deriveDisplayedUserMessageContent(text)).toMatchObject({
      visibleText: "Fix this",
      terminalContexts: [{ header: "Terminal 1 line 12", body: "12 | output" }],
      elementContexts: [{ header: "<button>", body: "selector: .submit" }],
      previewAnnotations: [{ id: "annotation_1", title: "Example" }],
    });
  });

  it("preserves attachment order across interleaved suffixes", () => {
    const text = [
      "Fix this",
      preview,
      terminal,
      element,
      preview.replace("annotation_1", "annotation_2"),
      terminal.replace("Terminal 1", "Terminal 2"),
      element.replace(".submit", ".cancel"),
    ].join("\n\n");
    const displayed = deriveDisplayedUserMessageContent(text);
    expect(displayed.visibleText).toBe("Fix this");
    expect(displayed.previewAnnotations.map((annotation) => annotation.id)).toEqual([
      "annotation_1",
      "annotation_2",
    ]);
    expect(displayed.terminalContexts.map((context) => context.header)).toEqual([
      "Terminal 1 line 12",
      "Terminal 2 line 12",
    ]);
    expect(displayed.elementContexts.map((context) => context.body)).toEqual([
      "selector: .submit",
      "selector: .cancel",
    ]);
  });
});

it("keeps literal context tags inside serialized payloads and separates repeated suffixes", () => {
  const terminal =
    "<terminal_context>\n- Terminal 1 line 1:\n  1 | <terminal_context></terminal_context>\n</terminal_context>";
  const element =
    "<element_context>\n- <div>:\n  html: <element_context></element_context>\n</element_context>";
  const preview =
    "<preview_annotation>\nId: note\nPage: Example\nComment: Fix <preview_annotation></preview_annotation>\n</preview_annotation>";
  const result = deriveDisplayedUserMessageContent(
    ["Fix this", terminal, element, preview, terminal, element, preview].join("\n\n"),
  );
  expect(result.visibleText).toBe("Fix this");
  expect(result.terminalContexts).toHaveLength(2);
  expect(result.elementContexts).toHaveLength(2);
  expect(result.previewAnnotations).toHaveLength(2);
  expect(result.previewAnnotations[0]?.comment).toBe(
    "Fix <preview_annotation></preview_annotation>",
  );
});
