import {
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ChatImageAttachment } from "./types";
import type { TerminalContextDraft } from "./lib/terminalContext";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface PersistedComposerImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}
