import { Extension } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export type ComposerVimMode = "insert" | "normal" | "visual" | "visual line" | "replace";

interface ComposerVimPluginState {
  readonly mode: ComposerVimMode;
  readonly search: RegExp | null;
}

/** The engine, which loads only once the setting is on. */
export interface ComposerVimHost {
  handleKeyDown(event: KeyboardEvent, dismissMenu: () => boolean): boolean;
  onTransaction(transaction: Transaction): void;
  onBlur(): void;
  /** Edits sharing an id undo together. */
  undoSession(): { readonly id: number; readonly isNew: boolean };
  onCaretMoved(): void;
  destroy(): void;
}

const hosts = new WeakMap<EditorView, ComposerVimHost>();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const composerVimKeyName = new PluginKey<ComposerVimPluginState>("composer-vim");

// The engine's registers hold text, so each chip gets one code unit that can round-trip. Lone low
// surrogates can't occur in well-formed text, so typed, pasted, or textarea text never decodes as one.
const FIRST_ATOM_CODE = 0xdc00;
const LAST_ATOM_CODE = 0xdfff;
const atomCharacters = new Map<string, string>();
const atomJson = new Map<string, ComposerVimAtomJson>();

interface ComposerVimAtomJson {
  readonly type: string;
}

function atomCharacter(json: ComposerVimAtomJson): string {
  const key = JSON.stringify(json);
  const existing = atomCharacters.get(key);
  if (existing) return existing;
  const code = FIRST_ATOM_CODE + atomCharacters.size;
  if (code > LAST_ATOM_CODE) return "\ufffc";
  const character = String.fromCharCode(code);
  atomCharacters.set(key, character);
  atomJson.set(character, json);
  return character;
}

export function composerVimAtomJson(character: string) {
  return atomJson.get(character);
}

export const COMPOSER_VIM_ATOM_PATTERN = /[\udc00-\udfff]/u;

export interface ComposerVimFlatDocument {
  readonly text: string;
  /** The ProseMirror position before each flat offset, plus the end. */
  readonly positions: ReadonlyArray<number>;
  readonly lineStarts: ReadonlyArray<number>;
}

const flatDocuments = new WeakMap<ProseMirrorNode, ComposerVimFlatDocument>();

/** One line per textblock or code block newline, and one character per inline atom. */
export function flattenComposerVimDocument(doc: ProseMirrorNode): ComposerVimFlatDocument {
  const cached = flatDocuments.get(doc);
  if (cached) return cached;
  let text = "";
  const positions: number[] = [];
  let end: number | null = null;
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    if (end !== null) {
      text += "\n";
      positions.push(end);
    }
    node.forEach((child, offset) => {
      const start = position + 1 + offset;
      if (child.isText) {
        text += child.text!;
        for (let index = 0; index < child.text!.length; index += 1) positions.push(start + index);
      } else {
        text +=
          child.type.name === "hardBreak"
            ? "\n"
            : atomCharacter(child.toJSON() as ComposerVimAtomJson);
        positions.push(start);
      }
    });
    end = position + 1 + node.content.size;
    return false;
  });
  positions.push(end ?? 0);
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const flat = { text, positions, lineStarts };
  flatDocuments.set(doc, flat);
  return flat;
}

export function composerVimFlatOffset(flat: ComposerVimFlatDocument, position: number): number {
  const { positions } = flat;
  let low = 0;
  let high = positions.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle]! < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function setComposerVimState(
  tr: Transaction,
  next: Partial<ComposerVimPluginState>,
): Transaction {
  return tr.setMeta(composerVimKeyName, next);
}

export function readComposerVimMode(state: EditorState): ComposerVimMode {
  return composerVimKeyName.getState(state)?.mode ?? "insert";
}

function searchDecorations(state: EditorState, query: RegExp): Decoration[] {
  const flat = flattenComposerVimDocument(state.doc);
  const pattern = new RegExp(query.source, `${query.flags.replace(/[gm]/g, "")}gm`);
  return [...flat.text.matchAll(pattern)]
    .filter((match) => match[0].length > 0)
    .map((match) =>
      Decoration.inline(
        flat.positions[match.index]!,
        flat.positions[match.index + match[0].length]!,
        { class: "rounded-[1px] bg-warning/30" },
      ),
    );
}

function cursorDecoration(state: EditorState): Decoration[] {
  const flat = flattenComposerVimDocument(state.doc);
  const cursor = composerVimFlatOffset(flat, state.selection.head);
  const character = flat.text[cursor];
  if (character === undefined || character === "\n") return [];
  const segment = graphemes.segment(flat.text).containing(cursor);
  const end = segment ? segment.index + segment.segment.length : cursor + 1;
  return [
    Decoration.inline(flat.positions[cursor]!, flat.positions[end]!, {
      class: "rounded-[1px] bg-foreground text-background",
    }),
  ];
}

export function handleComposerVimKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  dismissMenu: () => boolean,
): boolean {
  return hosts.get(view)?.handleKeyDown(event, dismissMenu) ?? false;
}

export function isComposerVimActive(view: EditorView): boolean {
  return hosts.has(view);
}

export function setComposerVimHost(view: EditorView, host: ComposerVimHost) {
  hosts.set(view, host);
}

/** Returns a cleanup that leaves vim mode, including when the engine is still loading. */
export function enableComposerVim(view: EditorView): () => void {
  let enabled = true;
  void import("./composer-vim-adapter").then(({ createComposerVimHost }) => {
    if (enabled && !view.isDestroyed) setComposerVimHost(view, createComposerVimHost(view));
  });
  return () => {
    enabled = false;
    hosts.get(view)?.destroy();
    hosts.delete(view);
  };
}

export const ComposerVimExtension = Extension.create({
  name: "composer-vim",
  // Tiptap runs these hooks last-listed first, so this extension must follow undo grouping to tag
  // a transaction before that extension classifies it.
  dispatchTransaction({ transaction, next }) {
    const host = hosts.get(this.editor.view);
    const external = transaction.getMeta("preventUpdate") === true;
    const inHistory = transaction.getMeta("addToHistory") !== false;
    if (!transaction.docChanged && !this.editor.state.selection.eq(transaction.selection)) {
      host?.onCaretMoved();
    } else if (transaction.docChanged && inHistory && !isHistoryTransaction(transaction)) {
      if (external) host?.onCaretMoved();
      const session = host?.undoSession();
      if (session?.isNew) closeHistory(transaction);
      if (session && transaction.getMeta("composition") == null) {
        transaction.setMeta("composition", session.id);
      }
    }
    next(transaction);
  },
  onTransaction({ transaction }) {
    hosts.get(this.editor.view)?.onTransaction(transaction);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<ComposerVimPluginState>({
        key: composerVimKeyName,
        state: {
          init: () => ({ mode: "insert", search: null }),
          apply(tr, value) {
            const next = tr.getMeta(composerVimKeyName) as
              | Partial<ComposerVimPluginState>
              | undefined;
            return next ? { ...value, ...next } : value;
          },
        },
        props: {
          decorations(state) {
            const plugin = composerVimKeyName.getState(state);
            if (!plugin || (plugin.mode === "insert" && !plugin.search)) return null;
            return DecorationSet.create(state.doc, [
              ...(plugin.search ? searchDecorations(state, plugin.search) : []),
              ...(plugin.mode === "normal" ? cursorDecoration(state) : []),
            ]);
          },
          handleDOMEvents: {
            blur(view) {
              // Window blur keeps activeElement; only focus really leaving counts.
              if (document.activeElement !== view.dom) hosts.get(view)?.onBlur();
              return false;
            },
          },
        },
      }),
    ];
  },
});
