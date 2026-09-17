import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode renders every
 * marker as a literal character and serializes byte-identically.
 */
export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  return <ComposerPromptEditorTiptap {...props} />;
}
