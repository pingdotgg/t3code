// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload, serializeCodeBlockToMarkdown } from "./markdown-clipboard";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("copying rendered Mermaid", () => {
  it.each(["across", "inside", "starts inside", "ends inside"])(
    "preserves fenced source when the selection is %s the diagram",
    (mode) => {
      const markdown = "```mermaid\nflowchart LR\n    A[Select message] --> B[Copy Markdown]\n```";
      document.body.innerHTML = `<div class="chat-markdown"><p>Before diagram.</p><div data-markdown-mermaid=""><button><svg><text>Select message</text></svg></button></div><p>After diagram.</p></div>`;
      document
        .querySelector("[data-markdown-mermaid]")!
        .setAttribute("data-markdown-copy", `${markdown}\n\n`);
      const before = document.querySelector("p")!.firstChild!;
      const after = document.querySelectorAll("p")[1]!.firstChild!;
      const label = document.querySelector("text")!.firstChild!;
      const range = document.createRange();
      range.setStart(mode === "inside" || mode === "starts inside" ? label : before, 2);
      range.setEnd(mode === "inside" || mode === "ends inside" ? label : after, 5);
      const selection = window.getSelection()!;
      selection.addRange(range);

      const expected = [
        mode === "across" || mode === "ends inside" ? "fore diagram." : null,
        markdown,
        mode === "across" || mode === "starts inside" ? "After" : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      expect(chatMarkdownClipboardPayload(selection)?.text).toBe(expected);
    },
  );

  it("uses a fence longer than backticks in the source", () => {
    expect(serializeCodeBlockToMarkdown("flowchart LR\n%% ```\n", "mermaid")).toBe(
      "````mermaid\nflowchart LR\n%% ```\n````\n\n",
    );
  });

  it("keeps source-view selections partial", () => {
    document.body.innerHTML = `<div class="chat-markdown" data-language="mermaid"><pre><code>flowchart LR\n    A --> B</code></pre></div>`;
    const code = document.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(code, 0);
    range.setEnd(code, 9);
    const selection = window.getSelection()!;
    selection.addRange(range);

    expect(chatMarkdownClipboardPayload(selection)?.text).toBe("flowchart");
  });
});
