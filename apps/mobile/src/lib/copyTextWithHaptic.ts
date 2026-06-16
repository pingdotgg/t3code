import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

export function copyTextWithHaptic(value: string): void {
  void Clipboard.setStringAsync(value);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}
