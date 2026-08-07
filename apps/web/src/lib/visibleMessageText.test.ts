import { describe, expect, it } from "vite-plus/test";

import { deriveDisplayedUserMessageContent } from "./visibleMessageText";

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
});
