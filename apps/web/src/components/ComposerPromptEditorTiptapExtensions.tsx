import { documentChipKindForFileName } from "~/pierre-icons";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Extension, InputRule, Node, wrappingInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";

import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import type { ServerProviderSkill } from "@t3tools/contracts";

import { use } from "react";
import { useEditor } from "@tiptap/react";

import { caretLineDirection } from "~/composer-text-direction";

import {
  caretTakesMarksBefore,
  convertBulletItemToTask,
  serializeEditorDoc,
  skillChipReplacements,
  type SkillMeta,
} from "~/composer-rich-text-doc";

import { basenameOfPath } from "~/pierre-icons";
import { WorkspaceEntryTooltip } from "./chat/WorkspaceEntryIcon";
import { FileTagChipContent } from "./chat/FileTagChip";
import { SkillChipPopover, skillPopoverDescription } from "./chat/SkillInlineText";

import { ContextChip } from "./ContextChip";
import {
  ComposerContextActionsContext,
  ComposerContextReferenceChip,
} from "./composerContextPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

import { createComposerExtensions } from "./ComposerPromptEditorTiptapParts";
import { ComposerCitationNodeView } from "./ComposerPromptEditorTiptapParts2";
import {
  CHIP_NODE_SELECTION_CLASS_NAME,
  RichComposerSkillsContext,
  resolvedThemeFromDocument,
} from "./composerPromptEditorTiptapContexts";

export const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-mention": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerMentionNodeView);
  },
});

function ComposerMentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const path = (node.attrs.path as string) ?? "";
  const chip = (
    <ContextChip
      kind={documentChipKindForFileName(path) ?? "mention"}
      dir="ltr"
      render={<button type="button" />}
      onClick={() => actions.openMention(path)}
      aria-label={`Preview ${path}`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        environmentId={actions.environmentId}
        cwd={actions.cwd}
        label={basenameOfPath(path)}
        theme={resolvedThemeFromDocument()}
      />
    </ContextChip>
  );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top">
          <WorkspaceEntryTooltip
            path={path}
            environmentId={actions.environmentId}
            cwd={actions.cwd}
          />
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

export const ComposerSkillExtension = Node.create({
  name: "composer-skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-skill]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-skill": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerSkillNodeView);
  },
});

/** Chip presentation for `$name`, or null when the provider does not offer it to users. */
export function composerSkillMeta(
  skills: ReadonlyArray<ServerProviderSkill>,
  name: string,
): SkillMeta | null {
  const skill = skills.find(
    (candidate) => candidate.name === name && isProviderSkillUserInvocable(candidate),
  );
  if (!skill) return null;
  const shortDescription = skill.shortDescription?.trim();
  return {
    label: formatProviderSkillDisplayName(skill),
    description: shortDescription || skill.description?.trim() || null,
  };
}

function ComposerSkillNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const skills = use(RichComposerSkillsContext);
  const skillName = (node.attrs.skillName as string) ?? "";
  const skillDescription = (node.attrs.skillDescription as string | null) ?? null;
  const skill = skills.find(
    (candidate) => candidate.name === skillName && isProviderSkillUserInvocable(candidate),
  );
  // The node outlives a provider switch, so its stored label can be another provider's.
  const skillLabel = skill
    ? formatProviderSkillDisplayName(skill)
    : (node.attrs.skillLabel as string) || skillName;
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <SkillChipPopover
        label={skillLabel}
        description={skill ? skillPopoverDescription(skill) : skillDescription}
        onViewInstructions={
          skill?.path && actions.environmentId ? () => actions.openMention(skill.path) : undefined
        }
      />
    </NodeViewWrapper>
  );
}

export const ComposerCitationExtension = Node.create({
  name: "composer-citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-citation]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-citation": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCitationNodeView);
  },
});

export const ComposerContextReferenceExtension = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-context-reference]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-context-reference": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerContextReferenceNodeView);
  },
});

function ComposerContextReferenceNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <ComposerContextReferenceChip
        kind={(node.attrs.kind as string) ?? ""}
        contextId={(node.attrs.contextId as string) ?? ""}
        label={(node.attrs.label as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}

type StyledRange = {
  from: number;
  to: number;
  markers: { at: number; side: number; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.nodeName === "codeBlock") continue;
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
      range.markers.push({
        at: run.pmPos,
        side: -1,
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({
        at: range.to,
        side: -2,
        text: map.value.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

/** Wait for a character after '- ' so task markers reach their input rule before becoming bullets. */
export function listMarkerInputRule(
  find: RegExp,
  listType: "bulletList" | "orderedList",
): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.marker ?? "-";
      const space = match.groups?.space ?? " ";
      const carried = match.groups?.carried ?? "";
      // Nested lists would serialize flat, so accept only top-level paragraphs.
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

export const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const checked = (match[1] ?? " ").toLowerCase() === "x";
    chain()
      .command(({ tr }) => {
        convertBulletItemToTask(tr, range.from, range.to, checked);
        return true;
      })
      .run();
    return undefined;
  },
});

export function taskInputRule(type: NodeType): InputRule {
  const rule = wrappingInputRule({
    find: /^- \[([ xX])\] $/,
    type,
    getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
  });
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).depth === 1 ? rule.handler(props) : null,
  });
}

export function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return true;
  }
  return false;
}

export const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

/** Require a space after *** or ___ to preserve bold typing. Lists and quotes cannot serialize rules. */
export const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/** Require a space to preserve PR references; lists and quotes cannot serialize headings. */
export const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

export function isInCodeBlock(view: EditorView): boolean {
  return view.state.selection.$from.parent.type.spec.code === true;
}

export const MarkerPluginKey = new PluginKey("composer-rich-markers");

export const ComposerMarkerPlugin = new Plugin({
  key: MarkerPluginKey,
  state: {
    init: (_, state) => decorationsForSelection(state),
    apply: (tr, old, _, state) =>
      tr.docChanged || tr.selectionSet || tr.storedMarksSet ? decorationsForSelection(state) : old,
  },
  props: {
    decorations(state) {
      return MarkerPluginKey.getState(state);
    },
  },
});

function decorationsForSelection(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const caretSide = caretTakesMarksBefore(state) ? 3 : 0;
  const rtl = caretLineDirection(state) === "rtl";
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
        );
        return false;
      }
      return true;
    });
  }
  for (const range of collectStyledRanges(doc)) {
    const active = selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from;
    if (!active) continue;
    for (const { at, side: baseSide, text } of range.markers) {
      const side = selection.empty && at === selection.from ? baseSide + caretSide : baseSide;
      const marker = document.createElement("span");
      marker.className = "composer-rich-marker";
      marker.textContent = text;
      marker.setAttribute("aria-hidden", "true");
      // Inline code is isolated left to right. In a right-to-left line its
      // opening backtick joins the closing one inside the isolate, or the line
      // would put both on the same side of the code.
      const codeMarks =
        rtl && baseSide === -1 && /^`+$/.test(text)
          ? doc.resolve(at).nodeAfter?.marks.filter((mark) => mark.type.spec.code)
          : undefined;
      decorations.push(
        Decoration.widget(at, marker, {
          side,
          key: `marker-${at}-${side}-${marker.textContent}`,
          ...(codeMarks?.length ? { marks: codeMarks } : {}),
        }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

export const ComposerMarkersExtension = Extension.create({
  name: "composer-rich-markers",
  addProseMirrorPlugins() {
    return [ComposerMarkerPlugin];
  },
});

export type TiptapEditor = NonNullable<ReturnType<typeof useEditor>>;

export function replaceSkillChips(
  editor: TiptapEditor,
  replacements: ReturnType<typeof skillChipReplacements>,
): void {
  const transaction = editor.state.tr.setMeta("addToHistory", false);
  for (const { from, to, node } of replacements) transaction.replaceWith(from, to, node);
  editor.view.dispatch(transaction);
}

export const RICH_TEXT_EXTENSIONS = createComposerExtensions(true);
export const PLAIN_TEXT_EXTENSIONS = createComposerExtensions(false);
