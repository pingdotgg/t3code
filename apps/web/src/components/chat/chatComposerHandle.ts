import type {
  AssistantCitation,
  EnvironmentContextRecord,
  KeybindingCommand,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ResponseContextRecord,
  RuntimeRequestId,
  ServerProvider,
  ThreadContextRecord,
} from "@t3tools/contracts";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import type { TerminalContextDraft, TerminalContextSelection } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { TransferredFiles } from "./workspaceFileDrop";

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFolders: (folders: File[]) => void;
  hasPendingAttachments: () => boolean;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  pasteTextAtEnd: (text: string, options?: { bypassAutoAttachment?: boolean }) => boolean;
  /** Attaches a paste's images, files and folders; false leaves the paste to text handling. */
  pasteAttachmentsAtEnd: (
    clipboardData: DataTransfer,
    transferred: TransferredFiles,
    options?: { bypassAutoAttachment?: boolean },
  ) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  replyToResponse: (response: ResponseContextRecord) => boolean;
  openModelPicker: () => void;
  stepReasoningEffort: (direction: 1 | -1) => void;
  toggleModelPicker: () => void;
  openControl: (command: KeybindingCommand) => void;
  isModelPickerOpen: () => boolean;
  isCaretAtStart: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  addTerminalContext: (selection: TerminalContextSelection) => void;
  getSendContext: () => {
    answeringPendingUserInput: boolean;
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    terminalContexts: TerminalContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    threadContexts: ThreadContextRecord[];
    environmentContexts: EnvironmentContextRecord[];
    selectedPromptEffort: string | null;
    selectedModelSelection: ModelSelection;
    multipleModelSelections: ReadonlyArray<ModelSelection> | null;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    shownPendingApprovalIds: ReadonlyArray<RuntimeRequestId>;
  };
  validateProviderInput: (providerInput: string) => boolean;
  setMultipleModelSelections: (selections: ReadonlyArray<ModelSelection>) => void;
}
