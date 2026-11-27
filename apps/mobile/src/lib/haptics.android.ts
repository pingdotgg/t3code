// oxlint-disable-next-line eslint/no-restricted-imports -- The Android haptics adapter every mobile module must use.
import {
  AndroidHaptics,
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  notificationAsync as nativeNotificationAsync,
  performAndroidHapticsAsync,
} from "expo-haptics";
import { Platform } from "react-native";

export { ImpactFeedbackStyle, NotificationFeedbackType };

// HapticFeedbackConstants.CONFIRM and REJECT were added in Android 11 (API 30).
const ANDROID_NOTIFICATION_HAPTICS_MIN_API = 30;

// Device-tuned touch effects avoid the weak, prolonged buzz of Expo's Android waveforms.
const impactFeedback: Record<ImpactFeedbackStyle, AndroidHaptics> = {
  [ImpactFeedbackStyle.Light]: AndroidHaptics.Clock_Tick,
  [ImpactFeedbackStyle.Soft]: AndroidHaptics.Clock_Tick,
  [ImpactFeedbackStyle.Medium]: AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Rigid]: AndroidHaptics.Context_Click,
  [ImpactFeedbackStyle.Heavy]: AndroidHaptics.Long_Press,
};

const notificationFeedback: Partial<Record<NotificationFeedbackType, AndroidHaptics>> = {
  [NotificationFeedbackType.Success]: AndroidHaptics.Confirm,
  [NotificationFeedbackType.Error]: AndroidHaptics.Reject,
};

export function impactAsync(
  style: ImpactFeedbackStyle = ImpactFeedbackStyle.Medium,
): Promise<void> {
  return performAndroidHapticsAsync(impactFeedback[style]);
}

export function notificationAsync(
  type: NotificationFeedbackType = NotificationFeedbackType.Success,
): Promise<void> {
  if (Number(Platform.Version) >= ANDROID_NOTIFICATION_HAPTICS_MIN_API) {
    const effect = notificationFeedback[type];
    if (effect !== undefined) {
      return performAndroidHapticsAsync(effect);
    }
  }
  return nativeNotificationAsync(type);
}

export function selectionAsync(): Promise<void> {
  return performAndroidHapticsAsync(AndroidHaptics.Clock_Tick);
}
