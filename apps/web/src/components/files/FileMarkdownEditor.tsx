import { registerCodeHighlighting } from "@lexical/code";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from "@lexical/react/LexicalAutoLinkPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import type { EditorState, EditorThemeClasses, LexicalEditor } from "lexical";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";

import {
  MARKDOWN_EDITOR_NODES,
  MARKDOWN_EDITOR_TRANSFORMERS,
  withTrailingNewlineFrom,
} from "./markdownInPlaceEditing";

const URL_REGEX =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;
const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

const MATCHERS = [
  createLinkMatcherWithRegExp(URL_REGEX, (text) => {
    return text.startsWith("http") ? text : `https://${text}`;
  }),
  createLinkMatcherWithRegExp(EMAIL_REGEX, (text) => {
    return `mailto:${text}`;
  }),
];

const editorTheme: EditorThemeClasses = {
  paragraph: "my-[0.65rem]",
  heading: {
    h1: "chat-markdown-h1 text-[1.25rem] font-semibold my-5 text-foreground",
    h2: "chat-markdown-h2 text-[1.125rem] font-semibold my-4 text-foreground",
    h3: "chat-markdown-h3 text-base font-semibold my-3 text-foreground",
    h4: "chat-markdown-h4 text-sm font-semibold my-2 text-foreground",
    h5: "chat-markdown-h5 text-sm font-semibold my-2 text-foreground",
    h6: "chat-markdown-h6 text-sm font-semibold my-2 text-muted-foreground",
  },
  list: {
    ul: "chat-markdown-ul list-disc pl-5 my-2.5",
    ol: "chat-markdown-ol list-decimal pl-5 my-2.5",
    listitem: "my-1",
    listitemChecked: "line-through opacity-70",
    listitemUnchecked: "",
    nested: {
      listitem: "list-none",
    },
  },
  quote: "border-l-2 border-border pl-4 my-2.5 italic text-muted-foreground",
  code: "block font-mono text-xs bg-muted/60 dark:bg-input/32 border border-border/70 dark:border-transparent rounded-[var(--radius)] p-3 my-2.5 whitespace-pre overflow-x-auto",
  codeHighlight: {
    atrule: "text-[#79b8ff] dark:text-[#79b8ff]",
    attr: "text-[#79b8ff] dark:text-[#79b8ff]",
    boolean: "text-[#56b6c2] dark:text-[#56b6c2]",
    builtin: "text-[#e5c07b] dark:text-[#e5c07b]",
    cdata: "text-[#5c6370] dark:text-[#5c6370]",
    char: "text-[#98c379] dark:text-[#98c379]",
    class: "text-[#e5c07b] dark:text-[#e5c07b]",
    comment: "text-[#5c6370] italic dark:text-[#5c6370]",
    constant: "text-[#d19a66] dark:text-[#d19a66]",
    deleted: "text-[#e06c75] dark:text-[#e06c75]",
    doctype: "text-[#5c6370] dark:text-[#5c6370]",
    entity: "text-[#56b6c2] dark:text-[#56b6c2]",
    function: "text-[#61afef] dark:text-[#61afef]",
    important: "text-[#e5c07b] font-bold dark:text-[#e5c07b]",
    inserted: "text-[#98c379] dark:text-[#98c379]",
    keyword: "text-[#c678dd] dark:text-[#c678dd]",
    number: "text-[#d19a66] dark:text-[#d19a66]",
    operator: "text-[#56b6c2] dark:text-[#56b6c2]",
    prolog: "text-[#5c6370] dark:text-[#5c6370]",
    property: "text-[#e06c75] dark:text-[#e06c75]",
    punctuation: "text-[#abb2bf] dark:text-[#abb2bf]",
    regex: "text-[#98c379] dark:text-[#98c379]",
    selector: "text-[#e5c07b] dark:text-[#e5c07b]",
    string: "text-[#98c379] dark:text-[#98c379]",
    symbol: "text-[#56b6c2] dark:text-[#56b6c2]",
    tag: "text-[#e06c75] dark:text-[#e06c75]",
    url: "text-[#61afef] underline dark:text-[#61afef]",
    variable: "text-[#e06c75] dark:text-[#e06c75]",
  },
  text: {
    bold: "font-semibold",
    italic: "italic",
    strikethrough: "line-through",
    underline: "underline",
    code: "font-mono bg-muted/60 px-1 py-0.5 rounded text-xs",
  },
  link: "text-info hover:underline cursor-pointer",
  hr: "my-4 border-t border-border/60",
};

function CodeHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return registerCodeHighlighting(editor);
  }, [editor]);
  return null;
}

function MarkdownSyncPlugin(props: {
  readonly text: string;
  readonly onChange: (nextText: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const lastEmittedTextRef = useRef(props.text);
  const isExternalSyncRef = useRef(false);

  useEffect(() => {
    if (props.text === lastEmittedTextRef.current) {
      return;
    }
    lastEmittedTextRef.current = props.text;
    isExternalSyncRef.current = true;
    editor.update(
      () => {
        $convertFromMarkdownString(props.text, MARKDOWN_EDITOR_TRANSFORMERS);
      },
      { tag: "external-sync" },
    );
  }, [editor, props.text]);

  const handleChange = useCallback(
    (editorState: EditorState, _editor: LexicalEditor, tags: Set<string>) => {
      if (tags.has("external-sync") || isExternalSyncRef.current) {
        isExternalSyncRef.current = false;
        return;
      }
      editorState.read(() => {
        // Lexical has no node for the newline a file ends with, so put the
        // file's own back before anything compares the two.
        const nextMarkdown = withTrailingNewlineFrom(
          props.text,
          $convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS),
        );
        if (nextMarkdown !== lastEmittedTextRef.current) {
          lastEmittedTextRef.current = nextMarkdown;
          props.onChange(nextMarkdown);
        }
      });
    },
    [props.onChange, props.text],
  );

  return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}

export interface FileMarkdownEditorProps {
  readonly text: string;
  readonly onChange: (nextText: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
}

export function FileMarkdownEditor(props: FileMarkdownEditorProps) {
  const initialTextRef = useRef(props.text);

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "file-markdown-editor",
      theme: editorTheme,
      nodes: MARKDOWN_EDITOR_NODES,
      editorState: () => {
        $convertFromMarkdownString(initialTextRef.current, MARKDOWN_EDITOR_TRANSFORMERS);
      },
      onError: (error) => {
        console.error("[file-markdown-editor] error:", error);
      },
    }),
    [],
  );

  return (
    <div
      className={cn("relative flex min-h-full w-full flex-1 flex-col", props.className)}
      data-testid="file-markdown-editor"
    >
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="chat-markdown relative min-h-full w-full min-w-0 max-w-4xl mx-auto px-6 py-5 text-sm leading-relaxed text-foreground/80 outline-none focus:outline-none focus-visible:outline-none [overflow-wrap:anywhere] [word-break:break-word]"
              aria-placeholder={props.placeholder ?? "Type markdown..."}
              placeholder={
                <div className="pointer-events-none absolute top-5 left-6 select-none text-sm text-muted-foreground/60">
                  {props.placeholder ?? "Type markdown..."}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <LinkPlugin />
        <ClickableLinkPlugin />
        <AutoLinkPlugin matchers={MATCHERS} />
        <HorizontalRulePlugin />
        <TabIndentationPlugin />
        <MarkdownShortcutPlugin transformers={MARKDOWN_EDITOR_TRANSFORMERS} />
        <CodeHighlightPlugin />
        <MarkdownSyncPlugin text={props.text} onChange={props.onChange} />
        {props.autoFocus ? <AutoFocusPlugin /> : null}
      </LexicalComposer>
    </div>
  );
}
