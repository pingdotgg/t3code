import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { memo, useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import { useDeadlinePassed } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

const COPY_FEEDBACK_DURATION_MS = 1200;

export const CopyTextButton = memo(function CopyTextButton(props: {
  readonly accessibilityLabel: string;
  readonly text: string;
  readonly onCopy?: () => Promise<void>;
  /** Lets a long-press menu wrap the button (`Menu` injects it on Android). */
  readonly onLongPress?: () => void;
  readonly tintColor?: ColorValue;
  readonly copiedTintColor?: ColorValue;
  readonly backgroundColor?: ColorValue;
  readonly borderColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const [copiedAtMs, setCopiedAtMs] = useState<number | null>(null);
  const feedbackEnded = useDeadlinePassed(
    copiedAtMs === null ? null : copiedAtMs + COPY_FEEDBACK_DURATION_MS,
  );
  const copied = copiedAtMs !== null && !feedbackEnded;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      disabled={props.text.length === 0}
      hitSlop={8}
      onLongPress={props.onLongPress}
      onPress={async () => {
        try {
          if (props.onCopy) await props.onCopy();
          else if (!(await tryCopyTextWithHaptic(props.text))) {
            Dialog.alert("Could not copy", "Try again.");
            return;
          }
        } catch {
          Dialog.alert("Could not copy", "Try again.");
          return;
        }
        setCopiedAtMs(Date.now());
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
        name={
          copied
            ? { ios: "checkmark", android: "check" }
            : { ios: "doc.on.doc", android: "content_copy" }
        }
        size={props.iconSize ?? 13}
        tintColor={copied ? (props.copiedTintColor ?? props.tintColor) : props.tintColor}
        tintColorClassName={props.tintColor ? undefined : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
});
