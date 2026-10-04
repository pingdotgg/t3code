import { markdownSourceRevision } from "./markdownReviewMapping";
import { Extension, Node, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  EditorContent,
  useEditor,
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  goToNextCell,
  tableEditing,
} from "@tiptap/pm/tables";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  parseRichMarkdown,
  serializeRichMarkdown,
  richSelectionSourceLines,
  type RichMarkdownDocument,
} from "./richMarkdownDocument";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const blockTypes = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "horizontalRule",
  "table",
];
const SourceIdentity = Extension.create({
  name: "sourceIdentity",
  addGlobalAttributes: () => [
    { types: blockTypes, attributes: { sourceId: { default: null, rendered: false } } },
  ],
  /** Attach ProseMirror table roles so cell selection and keyboard navigation work with the custom nodes. */
  extendNodeSchema(extension) {
    const role = { table: "table", tableRow: "row", tableCell: "cell", tableHeader: "header_cell" }[
      extension.name
    ];
    return role ? { tableRole: role } : {};
  },
  addProseMirrorPlugins: () => [tableEditing()],
  /** Navigate table cells with Tab while keeping edits in the current document. */
  addKeyboardShortcuts() {
    return {
      Tab: () => goToNextCell(1)(this.editor.state, this.editor.view.dispatch),
      "Shift-Tab": () => goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
    };
  },
});
const Table = Node.create({
  name: "table",
  group: "block",
  content: "tableRow+",
  isolating: true,
  parseHTML: () => [{ tag: "table" }],
  renderHTML: ({ HTMLAttributes }) => ["table", HTMLAttributes, ["tbody", 0]],
});
const TableRow = Node.create({
  name: "tableRow",
  content: "(tableCell | tableHeader)+",
  parseHTML: () => [{ tag: "tr" }],
  renderHTML: () => ["tr", 0],
});
/** Define Markdown-compatible table cells without adding a second document model. */
function cell(name: "tableCell" | "tableHeader", tag: "td" | "th") {
  return Node.create({
    name,
    content: "paragraph",
    isolating: true,
    addAttributes: () => ({
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
      align: { default: null },
    }),
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  });
}
const ImageWorkspace = createContext<{
  cwd: string;
  relativePath: string;
  threadRef: ScopedThreadRef;
} | null>(null);
/** Resolve workspace images inside the owning environment and defer external image loading until requested. */
function RichImage({ node }: NodeViewProps) {
  const workspace = useContext(ImageWorkspace);
  if (!workspace)
    return <NodeViewWrapper as="span">Image: {String(node.attrs.alt)}</NodeViewWrapper>;
  const separator = Math.max(
    workspace.relativePath.lastIndexOf("/"),
    workspace.relativePath.lastIndexOf("\\"),
  );
  const base =
    separator >= 0
      ? resolvePathLinkTarget(workspace.relativePath.slice(0, separator), workspace.cwd)
      : workspace.cwd;
  const source = classifyMarkdownImageSource(String(node.attrs.src), base);
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="inline-block max-w-full align-middle"
    >
      {source._tag === "WorkspaceFile" ? (
        <ChatMarkdownAssetImage
          environmentId={workspace.threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: workspace.threadRef.threadId,
            path: source.path,
          }}
          alt={String(node.attrs.alt)}
          workspaceRoot={workspace.cwd}
          framed={false}
        />
      ) : source._tag === "Direct" && /^(?:https?:|\/\/)/i.test(source.uri) ? (
        <img
          src={source.uri}
          alt={String(node.attrs.alt)}
          referrerPolicy="no-referrer"
          className="max-h-80 max-w-full"
        />
      ) : (
        <span>Image unavailable: {String(node.attrs.alt || node.attrs.src)}</span>
      )}
    </NodeViewWrapper>
  );
}
// Reuse signed environment assets rather than exposing host paths to the renderer.
const ImageReference = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes: () => ({ src: { default: "" }, alt: { default: "" }, title: { default: null } }),
  parseHTML: () => [{ tag: "img[src]" }],
  renderHTML: ({ node }) => [
    "span",
    { "data-image-reference": "", class: "rounded border px-1 text-muted-foreground" },
    `Image: ${node.attrs.alt || node.attrs.src}`,
  ],
  addNodeView: () => ReactNodeViewRenderer(RichImage),
});
export const richMarkdownExtensions = [
  StarterKit.configure({ link: { openOnClick: false }, underline: false, trailingNode: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  SourceIdentity,
  Table,
  TableRow,
  cell("tableCell", "td"),
  cell("tableHeader", "th"),
  ImageReference,
];
const tableJson: JSONContent = {
  type: "table",
  content: [0, 1].map((row) => ({
    type: "tableRow",
    content: [0, 1].map(() => ({
      type: row ? "tableCell" : "tableHeader",
      content: [{ type: "paragraph" }],
    })),
  })),
};

/** Enter rich mode only when the document can be round-tripped safely; otherwise explain the source fallback. */
export function RichMarkdownSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  onPendingChange: (path: string, pending: boolean) => void;
}) {
  const parsed = useMemo(() => parseRichMarkdown(props.contents), [props.contents]);
  if ("reason" in parsed)
    return (
      <p role="status" className="p-4">
        {parsed.reason} Select Source to continue editing.
      </p>
    );
  return <RichEditor {...props} document={parsed} />;
}
/** Send safe block-preserving edits through the existing save coordinator and keep failed edits visible. */
function RichEditor(
  props: Parameters<typeof RichMarkdownSurface>[0] & { document: RichMarkdownDocument },
) {
  const source = useRef(props.document);
  const published = useRef(props.contents);
  const save = useFileSaveCoordinator(props);
  const [error, setError] = useState("");
  const [slash, setSlash] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [showImages, setShowImages] = useState(false);
  const [note, setNote] = useState<{ source: string; startLine: number; endLine: number } | null>(
    null,
  );
  const [noteText, setNoteText] = useState("");
  const addReviewComment = useComposerDraftStore((s) => s.addReviewComment);
  const editor = useEditor(
    {
      extensions: richMarkdownExtensions,
      content: props.document.content,
      editorProps: {
        attributes: {
          class:
            "min-h-48 p-5 outline-none prose prose-sm dark:prose-invert max-w-none [&_td]:border [&_th]:border [&_td]:p-2 [&_th]:p-2 [&_table]:w-full [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_p]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3",
          "aria-label": "Rich Markdown document",
        },
      },
      onUpdate: ({ editor: current }) => {
        try {
          const next = serializeRichMarkdown(source.current, current.getJSON());
          published.current = next;
          setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, next);
          save.change(next);
          setError("");
        } catch (cause) {
          setError(
            cause instanceof Error
              ? `${cause.message} This edit remains in Rich view and has not been saved. Copy it before switching modes.`
              : "This edit cannot be saved safely. Copy it and use Source mode.",
          );
        }
        const { $from, empty, from } = current.state.selection;
        setSlash(
          empty && $from.parent.textBetween(0, $from.parentOffset).endsWith("/") ? from - 1 : null,
        );
      },
    },
    [props.environmentId, props.cwd, props.relativePath],
  );
  useEffect(() => {
    if (!editor || props.contents === published.current) return;
    source.current = props.document;
    published.current = props.contents;
    editor.commands.setContent(props.document.content, { emitUpdate: false });
  }, [editor, props.contents, props.document]);
  if (!editor) return null;
  const actions = [
    { name: "Heading", run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { name: "Bold", run: () => editor.chain().focus().toggleBold().run() },
    { name: "Italic", run: () => editor.chain().focus().toggleItalic().run() },
    { name: "List", run: () => editor.chain().focus().toggleBulletList().run() },
    { name: "Numbered", run: () => editor.chain().focus().toggleOrderedList().run() },
    { name: "Tasks", run: () => editor.chain().focus().toggleTaskList().run() },
    { name: "Quote", run: () => editor.chain().focus().toggleBlockquote().run() },
    { name: "Code", run: () => editor.chain().focus().toggleCodeBlock().run() },
    { name: "Table", run: () => editor.chain().focus().insertContent(tableJson).run() },
  ];
  const stale = note !== null && note.source !== props.contents;
  /** Map the current rich selection to the serialized source before adding agent-directed review context. */
  function captureNote() {
    if (!editor || editor.state.selection.empty) {
      setError("Select document text before adding a review note.");
      return;
    }
    const { $from, $to } = editor.state.selection;
    const range = richSelectionSourceLines(
      source.current,
      editor.getJSON(),
      $from.index(0),
      $to.index(0),
      published.current,
    );
    if (!range) {
      setError("The selection could not be mapped to source. Use Source mode to annotate it.");
      return;
    }
    setNote({ source: published.current, ...range });
  }
  const headings: { position: number; text: string }[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "heading") headings.push({ position, text: node.textContent });
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div
        className="sticky top-0 z-10 flex flex-wrap gap-1 border-b bg-background p-2"
        role="toolbar"
        aria-label="Markdown formatting"
      >
        {actions.map((action) => (
          <Button key={action.name} size="sm" variant="ghost" onClick={action.run}>
            {action.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={captureNote}>
          Review selection
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowImages((v) => !v)}>
          Image preview
        </Button>
        <details>
          <summary className="cursor-pointer p-1 text-sm">Outline</summary>
          {headings.map((heading) => (
            <Button
              key={heading.position}
              variant="ghost"
              onClick={() =>
                editor
                  .chain()
                  .focus(heading.position + 1)
                  .scrollIntoView()
                  .run()
              }
            >
              {heading.text || "Untitled heading"}
            </Button>
          ))}
        </details>
        <details>
          <summary className="cursor-pointer p-1 text-sm">Link or image</summary>
          <div className="flex gap-1">
            <Input
              aria-label="URL or workspace-relative path"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              onClick={() => {
                if (/^\s*(javascript|data|vbscript):/i.test(url)) return;
                editor.chain().focus().setLink({ href: url }).run();
              }}
            >
              Link
            </Button>
            <Button
              onClick={() => {
                if (/^\s*(javascript|data|vbscript):/i.test(url)) return;
                editor
                  .chain()
                  .focus()
                  .insertContent({ type: "image", attrs: { src: url, alt: "Image" } })
                  .run();
              }}
            >
              Image
            </Button>
          </div>
        </details>
      </div>
      <div className="flex flex-wrap gap-1 border-b p-1" aria-label="Table editing">
        {[
          ["Add row", addRowAfter],
          ["Remove row", deleteRow],
          ["Add column", addColumnAfter],
          ["Remove column", deleteColumn],
        ].map(([name, command]) => (
          <Button
            key={String(name)}
            size="sm"
            variant="ghost"
            disabled={!editor.isActive("table")}
            onClick={() => {
              if (typeof command === "function") command(editor.state, editor.view.dispatch);
              editor.commands.focus();
            }}
          >
            {String(name)}
          </Button>
        ))}
        <span className="p-1 text-xs text-muted-foreground">
          Tab / Shift+Tab moves between cells.
        </span>
      </div>
      {props.document.prefix.trim() ? (
        <details className="border-b p-2 text-sm">
          <summary>Front matter / source preamble (edit in Source)</summary>
          <pre className="whitespace-pre-wrap">{props.document.prefix}</pre>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="p-2 text-destructive">
          {error}
        </p>
      ) : null}
      {slash !== null ? (
        <div
          className="flex flex-wrap gap-1 border p-2"
          role="menu"
          aria-label="Insert Markdown block"
        >
          {actions.map((action) => (
            <Button
              role="menuitem"
              key={action.name}
              onClick={() => {
                editor.commands.deleteRange({ from: slash, to: slash + 1 });
                setSlash(null);
                action.run();
              }}
            >
              {action.name}
            </Button>
          ))}
          <Button onClick={() => setSlash(null)}>Dismiss</Button>
        </div>
      ) : null}
      <ImageWorkspace value={props}>
        <EditorContent editor={editor} />
      </ImageWorkspace>
      {note ? (
        <form
          className="m-3 grid gap-2 rounded border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const current =
              getOptimisticProjectFileQueryData(props.environmentId, props.cwd, props.relativePath)
                ?.contents ?? props.contents;
            if (note.source !== current) return;
            addReviewComment(props.composerDraftTarget, {
              ...buildFileReviewComment({
                id: randomUUID(),
                filePath: props.relativePath,
                startLine: note.startLine,
                endLine: note.endLine,
                text: noteText,
                contents: note.source,
              }),
              sourceRevision: markdownSourceRevision(note.source),
            });
            setNote(null);
            setNoteText("");
          }}
        >
          <p>
            {stale
              ? "Outdated selection: the document changed. Select the text again."
              : `Source lines ${note.startLine}–${note.endLine}`}
          </p>
          <Textarea
            aria-label="Review note for agent"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={stale || !noteText.trim()}>
              Attach to agent draft
            </Button>
            <Button type="button" variant="outline" onClick={() => setNote(null)}>
              Cancel note
            </Button>
          </div>
        </form>
      ) : null}
      {showImages ? (
        <FileMarkdownPreview
          cwd={props.cwd}
          relativePath={props.relativePath}
          text={props.contents}
          threadRef={props.threadRef}
        />
      ) : null}
    </div>
  );
}
