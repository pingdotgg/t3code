import type { OrchestrationMessageContext, ServerProviderSkill } from "@t3tools/contracts";
import type { Ref } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

export type ComposerEditorSelection = {
  readonly start: number;
  readonly end: number;
};

export type ComposerTextPaste = {
  readonly value: string;
  readonly eventCount: number;
  readonly text: string;
  readonly selection: ComposerEditorSelection;
};

export interface ComposerEditorHandle {
  focus: () => void;
  blur: () => void;
  setSelection: (selection: ComposerEditorSelection) => void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly context?: OrchestrationMessageContext;
  readonly clipboardFragment?: string;
  readonly onPasteContext?: (
    clipboard: ComposerTextPaste & {
      readonly fragment: string;
      readonly html: string;
    },
  ) => void;
  readonly skills?: ReadonlyArray<
    Pick<ServerProviderSkill, "name" | "displayName" | "shortDescription" | "description"> &
      Partial<Pick<ServerProviderSkill, "path">>
  >;
  readonly selection?: ComposerEditorSelection;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  /** Blocks user edits while preserving focus, selection, and the software keyboard. */
  readonly readOnly?: boolean;
  readonly scrollEnabled?: boolean;
  readonly autoCorrect?: boolean;
  readonly spellCheck?: boolean;
  readonly multiline?: boolean;
  readonly contentInsetVertical?: number;
  /** Android: center a single line vertically (collapsed pill); no-op on iOS. */
  readonly singleLineCentered?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: StyleProp<TextStyle>;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange?: (selection: ComposerEditorSelection) => void;
  readonly onPasteImages?: (uris: ReadonlyArray<string>) => void;
  readonly onContextPress?: (reference: {
    readonly source: string;
    readonly start: number;
    readonly end: number;
  }) => void;
  readonly onPasteText?: (paste: ComposerTextPaste) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Invoked by the native editor when Command-Return is pressed on a hardware keyboard. */
  readonly onSubmit?: () => void;
}
