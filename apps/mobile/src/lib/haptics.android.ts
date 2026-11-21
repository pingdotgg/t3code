import { AndroidHaptics, ImpactFeedbackStyle, performAndroidHapticsAsync } from "expo-haptics";

export { ImpactFeedbackStyle, NotificationFeedbackType, notificationAsync } from "expo-haptics";

// Device-tuned touch effects avoid the weak, prolonged buzz of Expo's Android waveforms.
const impactFeedback = {
  [ImpactFeedbackStyle.Light]: AndroidHaptics.Clock_Tick,
  [ImpactFeedbackStyle.Soft]: AndroidHaptics.Clock_Tick,
  [ImpactFeedbackStyle.Medium]: AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Rigid]: AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Heavy]: AndroidHaptics.Long_Press,
};

export function impactAsync(style = ImpactFeedbackStyle.Medium) {
  return performAndroidHapticsAsync(impactFeedback[style]);
}

export function selectionAsync() {
  return performAndroidHapticsAsync(AndroidHaptics.Clock_Tick);
}
