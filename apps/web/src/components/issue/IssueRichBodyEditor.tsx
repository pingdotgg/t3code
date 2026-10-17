import type { IssueRichBody } from "@t3tools/contracts";
import { baseKeymap, chainCommands, exitCode, toggleMark } from "@tiptap/pm/commands";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "@tiptap/pm/schema-list";
import { EditorState, type Command } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { DOMSerializer } from "@tiptap/pm/model";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  issueAdfSchema,
  readIssueAdf,
  safeIssueExternalUrl,
  issueAdfClipboard,
  issueRichSourceLabel,
  readIssueAdfClipboard,
} from "./issueAdf";

type IssueRichBodyEditorProps = {
  value: IssueRichBody;
  label: string;
  saving: boolean;
  disabled?: boolean;
  onSave: (value: IssueRichBody) => void;
  onCancel: () => void;
};

export function IssueRichBodyEditor(props: IssueRichBodyEditorProps) {
  const source = issueRichSourceLabel(props.value);
  return source === null ? (
    <IssueAdfBodyEditor {...props} />
  ) : (
    <IssueSourceBodyEditor {...props} source={source} />
  );
}

function editRichSource(source: string, next: string) {
  const previous = source.replace(/\r\n?/g, "\n");
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const sourceOffset = (offset: number) => {
    let index = 0;
    for (let count = 0; count < offset; count++, index++) {
      if (source[index] === "\r" && source[index + 1] === "\n") index++;
    }
    return index;
  };
  const prefix = source.slice(0, sourceOffset(start));
  const newline = prefix.match(/\r\n|\r|\n/g)?.at(-1) ?? source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  return (
    prefix + next.slice(start, nextEnd).replace(/\n/g, newline) + source.slice(sourceOffset(end))
  );
}

function IssueSourceBodyEditor({
  value,
  source,
  label,
  saving,
  disabled = false,
  onSave,
  onCancel,
}: IssueRichBodyEditorProps & { source: string }) {
  const [draft, setDraft] = useState(value.document);
  const id = useId();
  const locked = saving || disabled;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{source}</Label>
      <Textarea
        id={id}
        aria-label={label + " · " + source}
        size="lg"
        value={draft}
        maxLength={65_536}
        disabled={locked}
        onChange={(event) => {
          const next = event.target.value;
          setDraft((document) => editRichSource(document, next));
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={locked || draft.length > 65_536}
          onClick={() => onSave({ ...value, document: draft })}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function IssueAdfBodyEditor({
  value,
  label,
  saving,
  disabled = false,
  onSave,
  onCancel,
}: IssueRichBodyEditorProps) {
  const [initial] = useState(() => readIssueAdf(value));
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const locked = saving || disabled;
  useEffect(() => {
    if (!initial || !mount.current) return;
    const copy = (editor: EditorView, event: ClipboardEvent, cut: boolean) => {
      if (!event.clipboardData) return false;
      event.preventDefault();
      const slice = editor.state.selection.content();
      const native = issueAdfClipboard(slice);
      if (native.length > 262_144) {
        setError("The selected content is too large to copy safely.");
        return true;
      }
      event.clipboardData.setData("application/x-t3-issue-adf", native);
      event.clipboardData.setData(
        "text/plain",
        slice.content.textBetween(0, slice.content.size, "\n", "Preserved native content"),
      );
      if (cut && editor.editable) editor.dispatch(editor.state.tr.deleteSelection());
      return true;
    };
    const editor = new EditorView(mount.current, {
      state: EditorState.create({
        doc: initial.doc,
        plugins: [
          history(),
          keymap({
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Mod-b": toggleMark(issueAdfSchema.marks.strong!),
            "Mod-i": toggleMark(issueAdfSchema.marks.em!),
            Enter: chainCommands(splitListItem(issueAdfSchema.nodes.listItem!), baseKeymap.Enter!),
            Tab: sinkListItem(issueAdfSchema.nodes.listItem!),
            "Shift-Tab": liftListItem(issueAdfSchema.nodes.listItem!),
            "Mod-Enter": exitCode,
          }),
          keymap(baseKeymap),
        ],
      }),
      handleDOMEvents: {
        copy: (editor, event) => copy(editor, event, false),
        cut: (editor, event) => copy(editor, event, true),
      },
      handlePaste: (editor, event) => {
        const native = event.clipboardData?.getData("application/x-t3-issue-adf");
        if (!native) return false;
        const slice = readIssueAdfClipboard(native);
        if (slice === null) setError("This native content cannot be pasted safely.");
        else if (editor.editable) editor.dispatch(editor.state.tr.replaceSelection(slice));
        return true;
      },
      attributes: {
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        class:
          "min-h-32 rounded-md border border-input p-3 text-sm focus:outline-none [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:whitespace-pre-wrap [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_a]:underline",
      },
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [initial, label]);
  useEffect(() => {
    view.current?.setProps({ editable: () => !locked });
  }, [locked]);
  const run = (command: Command) => {
    const editor = view.current;
    if (!editor || locked) return;
    command(editor.state, editor.dispatch, editor);
    editor.focus();
  };
  const changeBlock = (name: "paragraph" | "heading" | "codeBlock", level?: number) =>
    run((state, dispatch) => {
      const transaction = state.tr.setBlockType(
        state.selection.from,
        state.selection.to,
        issueAdfSchema.nodes[name]!,
        (node) => ({ ...node.attrs, ...(level === undefined ? {} : { level }) }),
      );
      if (!transaction.docChanged) return false;
      dispatch?.(transaction);
      return true;
    });
  const applyLink = () => {
    const editor = view.current;
    if (!editor || locked || safeIssueExternalUrl(link) === null) return;
    const { from, to, empty } = editor.state.selection;
    const transaction = editor.state.tr;
    const type = issueAdfSchema.marks.link!;
    if (empty) {
      const held = editor.state.storedMarks ?? editor.state.selection.$from.marks();
      const current = held.find((mark) => mark.type === type);
      transaction.addStoredMark(type.create({ ...current?.attrs, href: link }));
    } else
      editor.state.doc.nodesBetween(from, to, (node, position) => {
        if (!node.isText) return;
        const current = node.marks.find((mark) => mark.type === type);
        transaction.addMark(
          Math.max(from, position),
          Math.min(to, position + node.nodeSize),
          type.create({ ...current?.attrs, href: link }),
        );
      });
    editor.dispatch(transaction);
    editor.focus();
    setLinkOpen(false);
  };
  const save = () => {
    if (!view.current || !initial || locked) return;
    const next = initial.serialize(view.current.state.doc);
    if (next.document.length > 262_144) {
      setError("The text is too long to save.");
      return;
    }
    setError(null);
    onSave(next);
  };
  if (!initial)
    return <p role="alert">This native content cannot be edited safely. Open it on the tracker.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div role="toolbar" aria-label="Text formatting" className="flex flex-wrap gap-1">
        {(
          [
            ["Bold", "strong"],
            ["Italic", "em"],
            ["Underline", "underline"],
            ["Strike", "strike"],
            ["Inline code", "code"],
          ] as const
        ).map(([title, name]) => (
          <Button
            key={name}
            type="button"
            size="xs"
            variant="outline"
            disabled={locked}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(toggleMark(issueAdfSchema.marks[name]!))}
          >
            {title}
          </Button>
        ))}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => changeBlock("paragraph")}
        >
          Text
        </Button>
        {[1, 2, 3, 4, 5, 6].map((level) => (
          <Button
            key={level}
            type="button"
            size="xs"
            variant="outline"
            disabled={locked}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => changeBlock("heading", level)}
          >
            {"Heading " + level}
          </Button>
        ))}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(wrapInList(issueAdfSchema.nodes.bulletList!))}
        >
          Bullet list
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(wrapInList(issueAdfSchema.nodes.orderedList!))}
        >
          Numbered list
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(liftListItem(issueAdfSchema.nodes.listItem!))}
        >
          Remove list
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => changeBlock("codeBlock")}
        >
          Code block
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setLink("");
            setLinkOpen(true);
          }}
        >
          Link
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(undo)}
        >
          Undo
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(redo)}
        >
          Redo
        </Button>
      </div>
      <div ref={mount} />
      <p className="text-xs text-muted-foreground">
        Preserved native content stays unchanged unless you remove it.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={locked} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit link</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label htmlFor="issue-rich-link">Link URL</Label>
            <Input
              id="issue-rich-link"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://"
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const editor = view.current;
                if (editor)
                  editor.dispatch(
                    editor.state.tr.removeMark(
                      editor.state.selection.from,
                      editor.state.selection.to,
                      issueAdfSchema.marks.link!,
                    ),
                  );
                setLinkOpen(false);
              }}
            >
              Remove link
            </Button>
            <Button
              size="sm"
              disabled={locked || safeIssueExternalUrl(link) === null}
              onClick={applyLink}
            >
              Apply link
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function IssueRichBodyView({ value }: { value: IssueRichBody }) {
  const source = issueRichSourceLabel(value);
  return source === null ? (
    <IssueAdfBodyView value={value} />
  ) : (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{source}</p>
      <pre className="whitespace-pre-wrap break-words text-sm">{value.document}</pre>
    </div>
  );
}

function IssueAdfBodyView({ value }: { value: IssueRichBody }) {
  const content = readIssueAdf(value);
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mount.current || !content) return;
    mount.current.replaceChildren(
      DOMSerializer.fromSchema(issueAdfSchema).serializeFragment(content.doc.content),
    );
  }, [content]);
  return (
    <div
      ref={mount}
      className="text-sm [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:whitespace-pre-wrap [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_a]:underline"
    />
  );
}
