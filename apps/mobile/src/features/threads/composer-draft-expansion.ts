/**
 * The model chip is a RN Pressable. The composer is a UITextView. iOS native
 * views win hit testing against overlapping RN siblings, so a chip laid out
 * over the editor selects text / shows Paste instead of opening settings.
 * Overlay only the compact dictation strip: the chip is not mounted then, and
 * the hidden 36px editor would otherwise leave a blank gap under the row.
 */
export function composerSettingsToolbarLayout(input: {
  readonly isExpanded: boolean;
  readonly isVoicePresented: boolean;
}): { readonly overlayEditor: boolean; readonly mount: boolean } {
  return {
    overlayEditor: !input.isExpanded && input.isVoicePresented,
    mount: input.isExpanded || input.isVoicePresented,
  };
}
