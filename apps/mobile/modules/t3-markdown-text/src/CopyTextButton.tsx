import { SymbolView } from "expo-symbols";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Pressable, type ColorValue } from "react-native";

const COPY_FEEDBACK_DURATION_MS = 1200;

/** Fires the tap haptic immediately; the returned promise carries the write outcome. */
function copyTextWithHaptic(value: string): Promise<boolean> {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  return Clipboard.setStringAsync(value).then(
    (didCopy) => didCopy,
    () => {
      console.error("Failed to copy text to the clipboard.");
      return false;
    },
  );
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

  const attemptRef = useRef(0);

  useEffect(() => {
    setCopied(false);
    return () => {
      attemptRef.current += 1;
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    };
  }, [props.text]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      disabled={props.text.length === 0}
      hitSlop={8}
      onPress={() => {
        const attempt = ++attemptRef.current;
        setCopied(false);
        if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
        void copyTextWithHaptic(props.text).then((didCopy) => {
          if (attempt !== attemptRef.current) return;
          if (!didCopy) {
            Alert.alert("Could not copy", "Try again.");
            return;
          }
          setCopied(true);
          if (resetTimeoutRef.current) {
            clearTimeout(resetTimeoutRef.current);
          }
          resetTimeoutRef.current = setTimeout(() => {
            setCopied(false);
            resetTimeoutRef.current = null;
          }, COPY_FEEDBACK_DURATION_MS);
        });
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
