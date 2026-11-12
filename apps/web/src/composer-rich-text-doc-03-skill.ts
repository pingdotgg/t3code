import {
  Fragment,
  Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from "@tiptap/pm/model";
import {
  Bold,
  starInputRegex as boldStarInputRegex,
  underscoreInputRegex as boldUnderscoreInputRegex,
} from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { Italic, starInputRegex, starPasteRegex } from "@tiptap/extension-italic";
import {
  type Command,
  type Editor,
  Extension,
  InputRule,
  markInputRule,
  markPasteRule,
  mergeAttributes,
} from "@tiptap/core";
import { Strike, inputRegex as strikeInputRegex } from "@tiptap/extension-strike";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";

export type SkillMeta = { label: string; description: string | null };

export const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

export const MARK_TO_TIPTAP: Record<RichTextMark, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

export const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

export type CodePair = { from: number; to: number };

export const codePairKey = new PluginKey<CodePair[]>("typedBacktickPairs");

// Input rules only see text before the caret, so filling an already typed
// pair needs a separate exit handler. Only typed pairs opt into that handler.
export function codePairCaretPlugin(type: MarkType) {
  return new Plugin<CodePair[]>({
    key: codePairKey,
    state: {
      init: () => [],
      apply(tr, pairs) {
        const mapped = pairs.flatMap((pair) => {
          const from = tr.mapping.mapResult(pair.from, 1);
          const to = tr.mapping.mapResult(pair.to, -1);
          return from.deleted || to.deleted ? [] : [{ from: from.pos, to: to.pos }];
        });
        const typed = (tr.getMeta(codePairKey) as CodePair | undefined) ?? composedCodePair(tr);
        return typed ? [...mapped, typed] : mapped;
      },
    },
    props: {
      handleTextInput(view, from, to, text, insert) {
        if (view.composing || from !== to || text !== "`") return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        const before = $from.nodeBefore?.text ?? "";
        if (closesBacktickPair($from)) {
          view.dispatch(insert().setMeta(codePairKey, { from: from - 1, to: from + 1 }));
          return true;
        }
        if (before.endsWith("`")) return false;

        // The opening tick can be typed after the closing one. Input rules
        // cannot recognize that pair because they only read before the caret.
        const after = $from.parent.textBetween(
          $from.parentOffset,
          $from.parent.content.size,
          "\n",
          "\n",
        );
        const match = /^([^`\n]+)`(?!`)/.exec(after);
        if (!match) return false;
        const end = from + match[1]!.length;
        let plain = true;
        view.state.doc.nodesBetween(from, end + 1, (node) => {
          if (node.isInline && (!node.isText || node.marks.length > 0)) plain = false;
        });
        if (!plain) return false;
        const tr = insert()
          .delete(end + 1, end + 2)
          .delete(from, from + 1);
        tr.addMark(from, end, type.create());
        tr.setSelection(TextSelection.create(tr.doc, from));
        tr.addStoredMark(type.create());
        view.dispatch(tr);
        return true;
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (!state.selection.empty || oldState.selection.from === state.selection.from) return null;
      if (transactions.some((tr) => tr.docChanged)) return null;
      const pair = codePairKey.getState(state)?.find(({ to }) => to === state.selection.from);
      if (!pair) return null;
      const $start = state.doc.resolve(pair.from);
      const $end = state.selection.$from;
      if (!$start.sameParent($end) || $start.parent.type.spec.code) return null;
      if (
        $start.nodeBefore?.text?.endsWith("`") ||
        $end.nodeAfter?.text?.startsWith("`") ||
        !/^`[^`]+`$/.test(state.doc.textBetween(pair.from, pair.to))
      ) {
        return null;
      }
      let plain = true;
      state.doc.nodesBetween(pair.from, pair.to, (node) => {
        if (node.isInline && (!node.isText || node.marks.length > 0)) plain = false;
      });
      if (!plain) return null;
      const tr = state.tr.delete(pair.to - 1, pair.to).delete(pair.from, pair.from + 1);
      tr.addMark(pair.from, pair.to - 2, type.create());
      tr.setSelection(TextSelection.create(tr.doc, pair.to - 2));
      tr.removeStoredMark(type);
      return tr;
    },
  });
}

/**
 * Whether a backtick typed at `$pos` would complete an empty `` pair. The
 * backtick before `$pos` only opens one when earlier backticks are all paired.
 */
export function closesBacktickPair($pos: ResolvedPos): boolean {
  return (
    $pos.parent.isTextblock &&
    !$pos.parent.type.spec.code &&
    /(^|[^`])`$/.test($pos.nodeBefore?.text ?? "") &&
    literalBackticksBefore($pos) % 2 === 1
  );
}

/**
 * Layouts where backtick is a dead key type it through composition, and the
 * pair handler above skips composing input. Read the pair
 * from the composed insert instead; dispatching mid-composition would break it.
 */
export function composedCodePair(tr: Transaction): CodePair | undefined {
  if (tr.getMeta("composition") === undefined || tr.steps.length !== 1) {
    return undefined;
  }

  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep) || step.from !== step.to || step.slice.size !== 1) {
    return undefined;
  }

  if (step.slice.content.firstChild?.text !== "`") {
    return undefined;
  }

  if (!closesBacktickPair(tr.before.resolve(step.from))) {
    return undefined;
  }

  return { from: step.from - 1, to: step.from + 1 };
}

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 */
export const ComposerCodeExtension = Code.extend({
  excludes: "code",
  // The forward arrow leaves code through the caret stops at styled edges, so
  // the stock exit (inserting a space at the end of a line) is not needed.
  exitable: false,
  // Code reads left to right inside an Arabic or Hebrew line, and the isolate
  // keeps its punctuation from trading places with the text around it.
  addOptions() {
    return { ...this.parent!(), HTMLAttributes: { dir: "ltr" } };
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), codePairCaretPlugin(this.type)];
  },
  // Tiptap's rule reads back from the caret, so after a literal `enabled` the
  // next typed backtick would reuse its closing backtick and wrap ` and ` in
  // code. Backticks pair left to right, so skip an opener that closes a pair.
  addInputRules() {
    return (this.parent?.() ?? []).map(
      (rule) =>
        new InputRule({
          find: rule.find,
          undoable: rule.undoable,
          handler: (props) => {
            if (literalBackticksBefore(props.state.doc.resolve(props.range.from)) % 2 === 1) {
              return null;
            }

            return rule.handler(props);
          },
        }),
    );
  },
});

/** Counts backticks typed as plain text before `$pos` in its textblock; code text never pairs. */
export function literalBackticksBefore($pos: ResolvedPos): number {
  let count = 0;
  $pos.parent.forEach((node, offset) => {
    if (offset >= $pos.parentOffset) return;
    if (!node.isText) {
      count = 0;
      return;
    }
    if (node.marks.some((mark) => mark.type.spec.code)) return;

    const text = node.text!.slice(0, $pos.parentOffset - offset);
    count += [...text.matchAll(/(?<!`)`(?!`)/g)].length;
  });
  return count;
}

// Code permits nested emphasis, so Tiptap's exclusion check cannot protect literal delimiters.
export function markInputRuleOutsideCode(find: RegExp, type: MarkType) {
  const rule = markInputRule({ find, type });
  return new InputRule({
    find,
    handler: (props) => {
      const { state, range, match } = props;
      const code = state.schema.marks.code;
      const content = match[match.length - 1] ?? "";
      const textStart = range.from + match[0].indexOf(content);
      const textEnd = textStart + content.length;
      if (
        code &&
        (state.doc.rangeHasMark(range.from + match[0].search(/\S/), textStart, code) ||
          state.doc.rangeHasMark(textEnd, state.selection.from, code))
      ) {
        return null;
      }
      return rule.handler(props);
    },
  });
}

/**
 * The composer writes italic as `*text*`, so it keeps only the `*` shortcuts.
 * Tiptap's `_text_` rules fire on the `_` in names like `node_modules` and
 * italicize back to an earlier `_build`, even one inside a code span.
 */
export const ComposerItalicExtension = Italic.extend({
  addInputRules() {
    return [markInputRuleOutsideCode(starInputRegex, this.type)];
  },
  addPasteRules() {
    return [markPasteRule({ find: starPasteRegex, type: this.type })];
  },
});

export const ComposerBoldExtension = Bold.extend({
  addInputRules() {
    return [
      markInputRuleOutsideCode(boldStarInputRegex, this.type),
      markInputRuleOutsideCode(boldUnderscoreInputRegex, this.type),
    ];
  },
});

export const ComposerStrikeExtension = Strike.extend({
  addInputRules() {
    return [markInputRuleOutsideCode(strikeInputRegex, this.type)];
  },
});

/**
 * Mod+B bolds selected text only. Without a selection Tiptap would toggle bold
 * for the next typed text, which users hit by accident when they mean the
 * sidebar toggle. Runs ahead of the Bold extension and swallows the chord.
 */
export const ComposerBoldSelectionOnlyExtension = Extension.create({
  name: "composerBoldSelectionOnly",
  priority: 1000,
  addKeyboardShortcuts() {
    const ignoreWithoutSelection = () => this.editor.state.selection.empty;
    return { "Mod-b": ignoreWithoutSelection, "Mod-B": ignoreWithoutSelection };
  },
});

/**
 * Tiptap's block chords can nest blocks inside quotes that the serializer cannot write,
 * silently dropping their text from stored drafts.
 */
export function withoutBlockChords<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(
    Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key)),
  ) as Shortcuts;
}

// Markdown supports one paragraph followed by nested lists per item.
export const LIST_ITEM_CONTENT = "paragraph list*";

/** Task lists come from `- [ ]` alone; Mod-Shift-9 would nest one in a quote. */
export const ComposerTaskListExtension = TaskList.extend({
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-9"]);
  },
});

/** Tiptap's nesting shortcuts leave indent unchanged, so rebuilding the draft undoes them. */
export const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

export const ComposerTaskItemExtension = TaskItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), LIST_NESTING_KEYS);
  },
}).configure({ nested: true });

export interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

export type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

export type InlineJson = Record<string, unknown>;

export interface DocLine {
  list: ListLinePrefix | null;
  inline: InlineJson[];
}

/** Null for a `$name` that is not one of the provider's skills: it stays editable text. */
export interface PendingItem {
  prefix: ListLinePrefix;
  content: InlineJson[];
  children: PendingList[];
}

export interface PendingList {
  key: string;
  items: PendingItem[];
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  openLen: number;
  closeLen: number;
  pmPos: number;
  mdStart: number;
  nodeName?: string;
}

// Shared by every caller that serializes the same doc, so it must not be mutated.
export interface RichDocMap {
  readonly value: string;
  readonly runs: ReadonlyArray<Readonly<RichRun>>;
  readonly docLength: number;
  readonly contextIds: ReadonlyArray<string>;
}

export interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  md: number;
}

export interface SkillChipReplacement {
  from: number;
  to: number;
  node: ProseMirrorNode;
}

/**
 * Use the same Markdown token boundaries as draft restoration. Apply edits
 * last-first so positions stay valid and unrelated citation nodes keep their keys.
 */
