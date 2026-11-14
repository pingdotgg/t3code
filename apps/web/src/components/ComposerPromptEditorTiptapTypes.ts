
import type { ComposerContextClipboardFragment, ServerProviderSkill } from "@t3tools/contracts";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

import type { ComposerDraftContextRecords } from "./composerContextPresentation";

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  draftKey?: string;
  value: string;
  cursor: number;
  richTextEnabled?: boolean;
  literalText?: boolean;
  contextRecords: ComposerDraftContextRecords;
  buildContextClipboardFragment?:
    | ((contextIds: ReadonlyArray<string>) => string | null)
    | undefined;
  importContextFragment?:
    | ((fragment: ComposerContextClipboardFragment) => ReadonlyMap<string, string>)
    | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  suggestionListId?: string | undefined;
  activeSuggestionId?: string | undefined;
  isPathQueryActive?: () => boolean;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (key: string, event: KeyboardEvent, isTaskItem?: boolean) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => void;
  /** Saves unsaved citation text into replacedValue when a controlled rewrite replaces the document. */
  onCitationDraftSave?: (replacedValue: string, savedValue: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
  insertedSpaces: CitationInsertedSpaces;
};

type CitationInsertedSpaces = { before: boolean; after: boolean };

export type OpenCitationComment = {
  key: string;
  sourceAnchor?: AssistantCitationSourceAnchor;
  removeOnCancel?: CitationInsertedSpaces;
};
