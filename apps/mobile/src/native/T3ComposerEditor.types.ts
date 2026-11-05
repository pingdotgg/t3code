import type { SelectableMarkdownModel } from "./SelectableMarkdownText.types";
import type { OrchestrationMessageContext, ServerProviderSkill } from "@t3tools/contracts";
import type { Ref } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

import type { ComposerEnterBehavior } from "../lib/composerEnterBehavior";

export type { ComposerEnterBehavior };

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
    Pick<
      ServerProviderSkill,
      "name" | "displayName" | "shortDescription" | "description" | "enabled" | "userInvocable"
    > &
      Partial<Pick<ServerProviderSkill, "path">>
  >;
  /** Models this environment knows; a reference to one of them shows as a chip. */
  readonly models?: ReadonlyArray<SelectableMarkdownModel>;
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
  /**
   * iOS: the owner's reset generation, raised synchronously when it replaces the text outright
   * (send, discard). Native edits the editor made before applying that reset are dropped.
   */
  readonly readResetGeneration?: () => number;
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
  /**
   * Size of the laid-out text in dp, without insets. Width is the widest line, so a
   * one-line draft reports its natural width; only fires when the size changes.
   */
  readonly onContentSizeChange?: (size: {
    readonly width: number;
    readonly height: number;
  }) => void;
  /**
   * Hardware-keyboard Return behavior on iOS. No-op on Android, which has no
   * hardware Return handling.
   */
  readonly enterBehavior?: ComposerEnterBehavior;
  readonly submitTitle?: string;
  readonly alternateSubmitTitle?: string;
  /** Command chords set alternate to reverse follow-up behavior; Android always passes false. */
  readonly onSubmit?: (alternate: boolean) => void;
}
