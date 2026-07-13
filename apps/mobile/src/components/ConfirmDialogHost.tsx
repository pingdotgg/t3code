import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText } from "./AppText";

export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
};

let presentRequest: ((request: ConfirmDialogRequest) => void) | null = null;

/**
 * Imperative confirm dialog, Alert.alert-shaped. Native iOS alerts already
 * match the app (and support per-button destructive red), so this is for
 * Android, where the native dialog can only theme all confirm buttons at
 * once. Requires ConfirmDialogHost to be mounted at the app root.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.(request);
}

/**
 * Android-style alert dialog matching the native one themed by
 * withAndroidModernAlertDialog — left-aligned text, right-aligned text
 * buttons — with what the native theme can't do: a per-dialog destructive
 * button color and a dimmer message than the title.
 */
export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  const pressedOverlay = useThemeColor("--color-subtle");

  useEffect(() => {
    presentRequest = setRequest;
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    request?.onCancel?.();
    setRequest(null);
  }, [request]);

  const handleConfirm = useCallback(() => {
    request?.onConfirm();
    setRequest(null);
  }, [request]);

  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleCancel}
    >
      {request === null ? null : (
        <View className="flex-1 items-center justify-center bg-backdrop px-8">
          <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
            <AppText className="text-lg font-t3-medium">{request.title}</AppText>
            {request.message === undefined ? null : (
              <AppText className="mt-2 text-sm text-foreground-secondary">
                {request.message}
              </AppText>
            )}
            <View className="mt-5 flex-row justify-end gap-1">
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4"
                  android_ripple={{ color: pressedOverlay }}
                  onPress={handleCancel}
                >
                  <AppText className="text-base font-t3-medium">
                    {request.cancelText ?? "Cancel"}
                  </AppText>
                </Pressable>
              </View>
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4"
                  android_ripple={{ color: pressedOverlay }}
                  onPress={handleConfirm}
                >
                  <AppText
                    className={cn(
                      "text-base font-t3-medium",
                      request.destructive && "text-danger-foreground",
                    )}
                  >
                    {request.confirmText}
                  </AppText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}
