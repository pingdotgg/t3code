import { createContext } from "react";

import type { ServerProviderSkill } from "@t3tools/contracts";
import type { OpenCitationComment } from "./ComposerPromptEditorTiptapTypes";

export const ComposerCitationCommentContext = createContext<{
  openComment: OpenCitationComment | null;
  onOpenChange: (citeKey: string, open: boolean) => void;
  onDraftChange: (citeKey: string, comment: string) => void;
  onSubmitAndSend: () => void;
}>({
  openComment: null,
  onOpenChange: () => {},
  onDraftChange: () => {},
  onSubmitAndSend: () => {},
});

export const RichComposerSkillsContext = createContext<ReadonlyArray<ServerProviderSkill>>([]);

export const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

export function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline-flex min-w-0 max-w-full select-none items-baseline data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";
