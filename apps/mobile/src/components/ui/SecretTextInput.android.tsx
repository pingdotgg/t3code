import { requireNativeView } from "expo";
import { processColor, View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { flattenThemeColor } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { SecretTextInputProps } from "./SecretTextInput.types";

interface NativeSecretInputProps extends ViewProps {
  readonly inputLabel: string;
  readonly value: string;
  readonly placeholder: string;
  readonly textColor: number;
  readonly placeholderColor: number;
  readonly cursorColor: number;
  readonly fontSize: number;
  readonly editable: boolean;
  readonly onChangeText: (event: NativeSyntheticEvent<{ readonly value: string }>) => void;
  readonly onSubmit: (event: NativeSyntheticEvent<{ readonly value: string }>) => void;
}

const NativeSecretInput = requireNativeView<NativeSecretInputProps>("T3SecretInput");

const FONT_SIZE = 16;
const LINE_HEIGHT = 24;

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

/**
 * Android's React Native TextInput cannot opt out of credential autofill, so password managers
 * offer logins above the keyboard. This field is a native EditText that reports no autofill type.
 * The frame matches AppTextInput's.
 */
export function SecretTextInput(props: SecretTextInputProps) {
  const theme = useUniwindTheme();
  const surface = theme["--color-input"];
  return (
    <View className="min-h-13.5 justify-center rounded-2xl border border-input-border bg-input px-3.5">
      <NativeSecretInput
        inputLabel={props.accessibilityLabel}
        value={props.value}
        placeholder={props.placeholder}
        textColor={nativeColor(flattenThemeColor(theme["--color-foreground"], surface))}
        placeholderColor={nativeColor(flattenThemeColor(theme["--color-placeholder"], surface))}
        cursorColor={nativeColor(flattenThemeColor(theme["--color-focus"], surface))}
        fontSize={FONT_SIZE}
        editable={props.editable}
        onChangeText={(event) => props.onChangeText(event.nativeEvent.value)}
        onSubmit={(event) => props.onSubmitEditing(event.nativeEvent.value)}
        style={{ height: LINE_HEIGHT }}
      />
    </View>
  );
}
