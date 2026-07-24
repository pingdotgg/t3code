import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_EDITOR_NAMESPACE,
  isComposerLexicalClipboardPayload,
} from "./ComposerPromptEditor.clipboard";

describe("isComposerLexicalClipboardPayload", () => {
  it("accepts payloads from the composer editor namespace", () => {
    expect(
      isComposerLexicalClipboardPayload(
        JSON.stringify({ namespace: COMPOSER_EDITOR_NAMESPACE, nodes: [] }),
      ),
    ).toBe(true);
  });

  it("rejects payloads from another Lexical editor namespace", () => {
    expect(
      isComposerLexicalClipboardPayload(JSON.stringify({ namespace: "another-editor", nodes: [] })),
    ).toBe(false);
  });

  it("rejects malformed payloads", () => {
    expect(isComposerLexicalClipboardPayload("not json")).toBe(false);
    expect(
      isComposerLexicalClipboardPayload(JSON.stringify({ namespace: COMPOSER_EDITOR_NAMESPACE })),
    ).toBe(false);
  });

  it("rejects payloads containing terminal-context nodes", () => {
    expect(
      isComposerLexicalClipboardPayload(
        JSON.stringify({
          namespace: COMPOSER_EDITOR_NAMESPACE,
          nodes: [
            {
              type: "paragraph",
              children: [{ type: "composer-terminal-context", context: { id: "terminal-1" } }],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
