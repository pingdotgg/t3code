import { SymbolView } from "expo-symbols";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, type ColorValue } from "react-native";

const COPY_FEEDBACK_DURATION_MS = 1200;

function copyTextWithHaptic(value: string): void {
  void Clipboard.setStringAsync(value);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export const CopyTextButton = memo(function CopyTextButton(props: {
  readonly accessibilityLabel: string;
  readonly text: string;
  readonly tintColor: ColorValue;
  readonly copiedTintColor?: ColorValue;
  readonly backgroundColor?: ColorValue;
  readonly borderColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      disabled={props.text.length === 0}
      hitSlop={8}
      onPress={() => {
        copyTextWithHaptic(props.text);
        setCopied(true);
        if (resetTimeoutRef.current) {
          clearTimeout(resetTimeoutRef.current);
        }
        resetTimeoutRef.current = setTimeout(() => {
          setCopied(false);
          resetTimeoutRef.current = null;
        }, COPY_FEEDBACK_DURATION_MS);
      }}
      style={({ pressed }) => ({
        width: props.buttonSize ?? 30,
        height: props.buttonSize ?? 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        borderWidth: props.borderColor ? 1 : 0,
        borderColor: props.borderColor,
        backgroundColor: props.backgroundColor,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={copied ? "checkmark" : "doc.on.doc"}
        size={props.iconSize ?? 13}
        tintColor={copied ? (props.copiedTintColor ?? props.tintColor) : props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
});
