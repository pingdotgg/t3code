import { MOBILE_SHAPE } from "../../lib/designTokens";
import { useEffect } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";

import { AppText } from "./AppText";
import { Button } from "./Button";
import { GlassSurface } from "./GlassSurface";
import { IconButton } from "./IconButton";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { SymbolView } from "./AppSymbol";

export interface ToastProps {
  readonly message: string;
  readonly description?: string;
  readonly tone?: "default" | "success" | "danger";
  readonly busy?: boolean;
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly onDismiss?: () => void;
}

/** The owning screen places and dismisses feedback; actions are never implicit. */
export function Toast(props: ToastProps) {
  useEffect(() => {
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(props.message);
  }, [props.message]);
  return (
    <GlassSurface className="p-3" style={{ borderRadius: MOBILE_SHAPE.toast }}>
      <View className="flex-row items-center gap-3">
        {props.busy ? (
          <AppActivityIndicator />
        ) : (
          <SymbolView
            name={props.tone === "danger" ? "exclamationmark.triangle" : "checkmark.circle"}
            size={20}
            tintColorClassName={
              props.tone === "danger" ? "accent-danger-foreground" : "accent-icon"
            }
          />
        )}
        <View className="min-w-0 flex-1" accessibilityLiveRegion="polite">
          <AppText textRole="footnote" className="font-t3-semibold">
            {props.message}
          </AppText>
          {props.description ? (
            <AppText textRole="label" className="text-foreground-muted">
              {props.description}
            </AppText>
          ) : null}
        </View>
        {props.onDismiss ? (
          <IconButton accessibilityLabel="Dismiss message" icon="xmark" onPress={props.onDismiss} />
        ) : null}
      </View>
      {props.action ? (
        <View className="mt-2 self-end">
          <Button label={props.action.label} onPress={props.action.onPress} />
        </View>
      ) : null}
    </GlassSurface>
  );
}
