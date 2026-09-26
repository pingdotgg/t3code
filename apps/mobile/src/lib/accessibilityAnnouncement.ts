import { AccessibilityInfo } from "react-native";

/**
 * Speak a status message through the active screen reader. Use it for state
 * transitions the user did not trigger by focus, such as an agent finishing a
 * turn. `accessibilityLiveRegion` only covers Android, so iOS needs this.
 */
export function announce(message: string): void {
  if (message.length === 0) return;
  // Queued so VoiceOver finishes what the user is reading, such as a long
  // response, instead of cutting it off mid-sentence. Android ignores it.
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}
