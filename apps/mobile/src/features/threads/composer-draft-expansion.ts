/**
 * The model chip is a RN Pressable. The composer is a UITextView. iOS native
 * views win hit testing against overlapping RN siblings, so a chip laid out
 * over the editor selects text / shows Paste instead of opening settings.
 * Never overlay the settings row on the editor. Mount it in flow, or not at all.
 */
export function composerSettingsToolbarLayout(input: {
  readonly isExpanded: boolean;
  readonly isVoicePresented: boolean;
}): { readonly overlayEditor: boolean; readonly mount: boolean } {
  return {
    overlayEditor: false,
    mount: input.isExpanded || input.isVoicePresented,
  };
}
