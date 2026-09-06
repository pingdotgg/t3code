import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  $copyNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  PASTE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { act, createRef, use, type ContextType } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { collapseExpandedComposerCursor } from "../composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { ComposerCitationCommentContext, ComposerCitationNode } from "./ComposerCitationNode";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

vi.mock("./chat/FileTagChip", () => ({
  FILE_TAG_CHIP_CLASS_NAME: "",
  FileTagChipContent: () => null,
}));
vi.mock("./chat/ComposerPendingTerminalContexts", () => ({
  ComposerPendingTerminalContextChip: () => null,
}));
vi.mock("./chat/AssistantCitationChip", () => ({ AssistantCitationChip: () => null }));

let lexicalEditor: LexicalEditor;
let citationComments: ContextType<typeof ComposerCitationCommentContext>;
// Keep the real composer, registered nodes, updates, and snapshot API. Only the
// DOM view is omitted so Lexical runs headlessly in this component test.
vi.mock("@lexical/react/LexicalPlainTextPlugin", () => ({
  PlainTextPlugin: function HeadlessEditor() {
    [lexicalEditor] = useLexicalComposerContext();
    citationComments = use(ComposerCitationCommentContext);
    return null;
  },
}));

let renderer: ReactTestRenderer | undefined;
const editorRef = createRef<ComposerPromptEditorHandle>();

function composer(value: string) {
  return (
    <ComposerPromptEditor
      value={value}
      cursor={collapseExpandedComposerCursor(value, value.length)}
      terminalContexts={[]}
      skills={[]}
      disabled={false}
      placeholder="Write a prompt"
      onRemoveTerminalContext={() => {}}
      onChange={() => {}}
      onPaste={() => {}}
      editorRef={editorRef}
    />
  );
}

async function renderPrompt(value: string) {
  await act(() => {
    if (renderer) renderer.update(composer(value));
    else renderer = create(composer(value));
  });
}

function $firstMention() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
  const mention = paragraph.getFirstChildOrThrow();
  if (mention.getType() !== "composer-mention") throw new Error("Expected a mention");
  return mention;
}

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("composer mention serialization", () => {
  it.each([
    "@README.md control",
    "@terminal-1:3 Explain this output\n\n<terminal_context>\n- Terminal 1 line 3:\n  3 | output\n</terminal_context>",
    '@"docs/My \\"File\\".md" please',
    '@"docs/雪 👋.md" please',
    "[README.md](README.md) control",
    "[config#draft?.json](config%23draft%3f.json) control",
    "Plain text\n  Keep indentation 👋",
  ])("preserves the initial prompt %s", async (prompt) => {
    await renderPrompt(prompt);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  });

  it("preserves original source when replacing the controlled prompt", async () => {
    for (const prompt of ["", "@README.md control", "Older plain control", "@README.md control"]) {
      await renderPrompt(prompt);
      expect(editorRef.current?.readSnapshot()).toMatchObject({
        value: prompt,
        expandedCursor: prompt.length,
      });
      if (prompt === "@README.md control") {
        expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
      }
    }
  });

  it("preserves source when Lexical clones the mention and reloads exported state", async () => {
    const prompt = '@"docs/雪 👋.md" remains a chip';
    await renderPrompt(prompt);
    const originalKey = lexicalEditor.getEditorState().read(() => $firstMention().getKey());

    await act(() => {
      lexicalEditor.update(
        () => {
          const mention = $firstMention();
          mention.replace($copyNode(mention));
        },
        { discrete: true },
      );
    });
    expect(lexicalEditor.getEditorState().read(() => $firstMention().getKey())).not.toBe(
      originalKey,
    );
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    const exportedState = lexicalEditor.getEditorState().toJSON();

    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exportedState));
    });
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("keeps canonical serialization when importing legacy mention JSON without source", async () => {
    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(
        lexicalEditor.parseEditorState(
          JSON.stringify({
            root: {
              type: "root",
              version: 1,
              children: [
                {
                  type: "paragraph",
                  version: 1,
                  children: [{ type: "composer-mention", version: 1, path: "README.md" }],
                },
              ],
            },
          }),
        ),
      );
    });
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md)");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("still serializes a newly inserted mention canonically", async () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    await renderPrompt("");
    const event = new TestClipboardEvent("@README.md ");
    await act(() => {
      lexicalEditor.update(
        () => {
          $getRoot().selectEnd();
          lexicalEditor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
        },
        { discrete: true },
      );
    });
    expect(event.defaultPrevented).toBe(true);
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md) ");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });
});

describe("composer citation cancellation", () => {
  const citation: AssistantCitation = {
    version: 1,
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    text: "Selected assistant text",
    start: 0,
    end: 23,
    prefix: "",
    suffix: "",
  };
  const source = serializeAssistantCitation(citation);
  const savedSource = serializeAssistantCitation({ ...citation, comment: "Saved comment" });
  const sourceAnchor: AssistantCitationSourceAnchor = {
    source: { nodeType: 1 } as HTMLElement,
    range: { collapsed: false } as Range,
    viewport: { nodeType: 1 } as HTMLElement,
  };

  async function cite(previousValue: string) {
    await renderPrompt(previousValue);
    const prefix = previousValue ? `${previousValue} ` : "";
    const value = `${prefix}${source} `;
    await act(() => {
      editorRef.current?.requestCitationComment({
        previousValue,
        value,
        citationStart: prefix.length,
        sourceAnchor,
      });
    });
    await renderPrompt(value);
    const target = citationComments.openComment;
    expect(target).not.toBeNull();
    return target!.nodeKey;
  }

  it.each(["", "Keep my draft.", `@README.md\n  雪 👋 ${savedSource}`])(
    "restores the original draft when a new citation is cancelled: %s",
    async (previousValue) => {
      const nodeKey = await cite(previousValue);
      await act(() => citationComments.onCancel(nodeKey));
      expect(editorRef.current?.readSnapshot().value).toBe(previousValue);
      expect(citationComments.openComment).toBeNull();
    },
  );

  it("preserves edits made to the draft after inserting the citation", async () => {
    const previousValue = `Keep ${savedSource}`;
    const nodeKey = await cite(previousValue);
    await act(() => {
      lexicalEditor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(paragraph)) throw new Error("Expected composer paragraph");
          paragraph.append($createTextNode("Typed meanwhile"));
        },
        { discrete: true },
      );
    });
    await act(() => citationComments.onCancel(nodeKey));
    expect(editorRef.current?.readSnapshot().value).toBe(`${previousValue}  Typed meanwhile`);
    expect(citationComments.openComment).toBeNull();
  });

  it("keeps a saved citation and its comment when cancelling a comment edit", async () => {
    const value = `Keep ${savedSource} and this draft.`;
    await renderPrompt(value);
    const nodeKey = lexicalEditor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      if (!$isElementNode(paragraph)) throw new Error("Expected composer paragraph");
      const node = paragraph.getChildren().find((child) => child instanceof ComposerCitationNode);
      if (!node) throw new Error("Expected saved citation");
      return node.getKey();
    });
    await act(() => citationComments.onOpenChange(nodeKey, true));
    await act(() => citationComments.onCancel(nodeKey));
    expect(editorRef.current?.readSnapshot().value).toBe(value);
    expect(citationComments.openComment).toBeNull();
  });
});
