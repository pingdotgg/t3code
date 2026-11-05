import { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerCodeBlockExtension } from "~/composer-rich-text-doc";
import type { DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import {
  composerCodeBlockHighlight,
  MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH,
  shouldHighlightCodeBlock,
  tokenizeBlock,
} from "./composerCodeBlockHighlight";

vi.mock("~/lib/syntaxHighlighting", () => ({ getSyntaxHighlighterPromise: vi.fn() }));

const THEME = "github-dark" as DiffThemeName;

/**
 * Stands in for the Shiki highlighter so the offset arithmetic can be checked
 * without loading a real grammar. Splits each line into whitespace-delimited
 * tokens, which is enough shape for the flattening logic under test.
 */
function fakeHighlighter(colorFor: (content: string) => string | undefined) {
  return {
    codeToTokens(code: string) {
      return {
        tokens: code.split(/\r?\n/).map((line) =>
          line
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((content) => ({ content, color: colorFor(content) })),
        ),
      };
    },
  } as unknown as Parameters<typeof tokenizeBlock>[0];
}

describe("composer code block highlighting", () => {
  it("maps token offsets to positions within the block text", () => {
    const highlighter = fakeHighlighter((content) => (content === "const" ? "#ff0000" : undefined));

    const decorations = tokenizeBlock(highlighter, "const answer = 42", "ts", THEME);

    expect(decorations).toEqual([{ from: 0, to: 5, color: "#ff0000" }]);
  });

  it("accounts for the newline between lines", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\ntwo", "ts", THEME);

    // "one" is 3 characters, then the newline, so "two" starts at 4.
    expect(decorations).toEqual([{ from: 4, to: 7, color: "#00ff00" }]);
  });

  it("accounts for both characters of a CRLF line break", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\r\ntwo", "ts", THEME);

    expect(decorations).toEqual([{ from: 5, to: 8, color: "#00ff00" }]);
  });

  it("skips whitespace-only tokens so indentation is not decorated", () => {
    const highlighter = fakeHighlighter(() => "#0000ff");

    const decorations = tokenizeBlock(highlighter, "  indented", "ts", THEME);

    expect(decorations).toEqual([{ from: 2, to: 10, color: "#0000ff" }]);
  });

  it("falls back to plain text when the grammar throws", () => {
    const throwing = {
      codeToTokens() {
        throw new Error("unsupported language");
      },
    } as unknown as Parameters<typeof tokenizeBlock>[0];

    expect(tokenizeBlock(throwing, "const answer = 42", "nope", THEME)).toEqual([]);
  });
});

describe("the highlighting size cap", () => {
  // Each keystroke re-tokenizes the whole fence on the main thread; past a
  // few hundred lines that stalls typing, so large fences stay plain.
  it("highlights a fence up to the cap", () => {
    expect(shouldHighlightCodeBlock("x".repeat(MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH))).toBe(true);
  });

  it("leaves a fence past the cap plain", () => {
    expect(shouldHighlightCodeBlock("x".repeat(MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH + 1))).toBe(false);
  });
});

describe("a highlighter that fails to load", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Shiki can fail to initialize at all. The blocks it could not reach stay
   * plain, the ones it could are still painted, and nothing is left rejected.
   */
  it("still repaints the blocks whose highlighter loaded", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockImplementation((language) =>
      language === "ts"
        ? Promise.resolve(fakeHighlighter(() => "#ff0000"))
        : Promise.reject(new Error("Shiki failed to initialize")),
    );
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false, trailingNode: false }),
        ComposerCodeBlockExtension,
        composerCodeBlockHighlight({ resolveTheme: () => THEME }),
      ],
      content: {
        type: "doc",
        content: [
          { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "a" }] },
          { type: "codeBlock", attrs: { language: "py" }, content: [{ type: "text", text: "b" }] },
        ],
      },
    });
    // The plugin watches <html> for theme changes; the unit suite has no DOM.
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // ProseMirror names each plugin after its key, though it does not type it.
    const plugin = editor.extensionManager.plugins.find((candidate) =>
      (candidate as unknown as { key: string }).key.startsWith("composerCodeBlockHighlight"),
    );
    const repainted = new Promise<void>((resolve) => {
      const view = {
        get state() {
          return editor.state;
        },
        dispatch: () => resolve(),
      } as unknown as EditorView;
      plugin?.spec.view?.(view);
    });

    await expect(repainted).resolves.toBeUndefined();
  });
});
