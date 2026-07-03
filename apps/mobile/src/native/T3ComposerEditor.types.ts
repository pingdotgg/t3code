import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Ref } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

export type ComposerEditorSelection = {
  readonly start: number;
  readonly end: number;
};

export interface ComposerEditorHandle {
  focus: () => void;
  blur: () => void;
  setSelection: (selection: ComposerEditorSelection) => void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly skills?: ReadonlyArray<
    Pick<ServerProviderSkill, "name" | "displayName" | "shortDescription" | "description">
  >;
  readonly selection?: ComposerEditorSelection;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly scrollEnabled?: boolean;
  readonly autoCorrect?: boolean;
  readonly spellCheck?: boolean;
  readonly multiline?: boolean;
  readonly contentInsetVertical?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: StyleProp<TextStyle>;
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange?: (selection: ComposerEditorSelection) => void;
  readonly onPasteImages?: (uris: ReadonlyArray<string>) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Invoked by the native editor when Command-Return is pressed on a hardware keyboard. */
  readonly onSubmit?: () => void;
}
