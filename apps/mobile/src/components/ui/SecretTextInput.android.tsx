import { requireNativeView } from "expo";
import type { Ref } from "react";
import { processColor, View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { cn } from "../../lib/cn";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { SecretTextInputProps } from "./SecretTextInput.types";

interface NativeSecretInputRef {
  focus: () => Promise<void>;
}

interface NativeSecretInputProps extends ViewProps {
  readonly ref?: Ref<NativeSecretInputRef>;
  readonly inputLabel: string;
  readonly value: string;
  readonly placeholder: string;
  readonly textColor: number;
  readonly placeholderColor: number;
  readonly cursorColor: number;
  readonly fontSize: number;
  readonly editable: boolean;
  readonly masked: boolean;
  readonly returnKey: "next" | "done";
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
export function SecretTextInput({ onMount, ...props }: SecretTextInputProps) {
  const theme = useUniwindTheme();
  const surface = theme["--color-input"];
  return (
    <View
      className={cn(
        "min-h-13.5 justify-center rounded-2xl border border-input-border bg-input px-3.5",
        props.className,
      )}
    >
      <NativeSecretInput
        ref={
          onMount === undefined
            ? undefined
            : (native: NativeSecretInputRef | null) =>
                onMount(
                  native === null
                    ? null
                    : { focus: () => void native.focus().catch(() => undefined) },
                )
        }
        inputLabel={props.accessibilityLabel}
        value={props.value}
        placeholder={props.placeholder}
        textColor={nativeColor(flattenThemeColor(theme["--color-foreground"], surface))}
        placeholderColor={nativeColor(flattenThemeColor(theme["--color-placeholder"], surface))}
        cursorColor={nativeColor(flattenThemeColor(theme["--color-focus"], surface))}
        fontSize={FONT_SIZE}
        editable={props.editable}
        masked={props.revealed !== true}
        returnKey={props.returnKeyType ?? "done"}
        onChangeText={(event) => props.onChangeText(event.nativeEvent.value)}
        onSubmit={(event) => props.onSubmitEditing(event.nativeEvent.value)}
        style={{ height: LINE_HEIGHT }}
      />
    </View>
  );
}
