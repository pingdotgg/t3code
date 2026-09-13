import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  TRANSFORMERS,
  type ElementTransformer,
  type Transformer,
} from "@lexical/markdown";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { createEditor, type LexicalNode } from "lexical";
import { useRef, useState } from "react";

const HR: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node: LexicalNode) => {
    return $isHorizontalRuleNode(node) ? "---" : null;
  },
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parentNode, _children, _match, isImport) => {
    const line = $createHorizontalRuleNode();
    if (isImport) {
      parentNode.replace(line);
    } else {
      parentNode.insertBefore(line);
    }
    line.selectNext();
  },
  type: "element",
};

export const MARKDOWN_EDITOR_TRANSFORMERS: Array<Transformer> = [HR, CHECK_LIST, ...TRANSFORMERS];

export const MARKDOWN_EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  AutoLinkNode,
  LinkNode,
  HorizontalRuleNode,
];

/**
 * The editor rewrites the whole file from its own node tree, so it may only
 * open a file whose markdown survives that trip unchanged. Nested lists come
 * back flattened, `~~~` fences escaped, front matter split by blank lines,
 * CRLF collapsed, hard breaks dropped, and a fence inside a list dedented —
 * saving any of those would rewrite the file around the user's edit.
 */
export function markdownRoundTrip(text: string): string | null {
  try {
    const editor = createEditor({
      nodes: MARKDOWN_EDITOR_NODES,
      onError: (error) => {
        throw error;
      },
    });
    let exported = "";
    editor.update(
      () => {
        $convertFromMarkdownString(text, MARKDOWN_EDITOR_TRANSFORMERS);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      exported = $convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS);
    });
    return exported;
  } catch {
    return null;
  }
}

/**
 * Markdown the editor has no node for. It round-trips, so nothing is lost, but
 * it would sit in the rendered view as its own source — which is the opposite
 * of what reading rendered markdown is for. Rarer cases that read as source
 * this way, such as footnotes and reference links, are left editable.
 */
const UNRENDERABLE_MARKDOWN = [
  /^ {0,3}\|.*\|/m, // tables
  /!\[[^\]]*\]\s*[[(]/, // images
  /^ {0,3}<[a-zA-Z!/]/m, // raw HTML blocks
];

/**
 * The check parses and re-serializes the whole file on the render that opens
 * it: about 20 ms at this size, 225 ms at the 1 MB the preview will load. A
 * document this long is a poor fit for editing in a preview panel anyway, so
 * past here it stays rendered and the source view does the editing.
 */
const MAX_IN_PLACE_EDITING_CHARACTERS = 64 * 1024;

export function markdownSupportsInPlaceEditing(text: string): boolean {
  if (text.length > MAX_IN_PLACE_EDITING_CHARACTERS) return false;
  if (UNRENDERABLE_MARKDOWN.some((pattern) => pattern.test(text))) return false;
  return markdownRoundTrip(text) === text.replace(/\n+$/, "");
}

/** Lexical drops the file's trailing newline; keep whatever the file had. */
export function withTrailingNewlineFrom(source: string, next: string): string {
  if (next.endsWith("\n")) return next;
  return next + (/\n+$/.exec(source)?.[0] ?? "");
}

interface InPlaceEditingCheck {
  readonly source: string;
  readonly enabled: boolean;
  readonly supported: boolean;
}

function check(source: string, enabled: boolean): InPlaceEditingCheck {
  return { source, enabled, supported: enabled && markdownSupportsInPlaceEditing(source) };
}

/**
 * Whether the rendered view can host the editor for the file it is showing.
 * Text the editor produced needs no check — it is already what the editor can
 * represent — so typing never re-parses the document. Text from anywhere else,
 * including an agent rewriting the open file, is checked before the editor
 * keeps it.
 */
export function useInPlaceMarkdownEditing(contents: string, enabled: boolean) {
  const editorTextRef = useRef<string | null>(null);
  const [current, setCurrent] = useState(() => check(contents, enabled));

  const fromEditor = contents === editorTextRef.current;
  const stale = current.enabled !== enabled || (current.source !== contents && !fromEditor);
  const next = stale ? check(contents, enabled) : current;
  if (stale) setCurrent(next);

  return {
    supportsEditing: next.supported,
    rememberEditorText: (text: string) => {
      editorTextRef.current = text;
    },
  };
}
