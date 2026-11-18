import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";

/** Shell mode has no Escape on mobile, so the indicator carries its own way out. */
export function ComposerShellModeBanner(props: {
  readonly canRun: boolean;
  readonly onExit: () => void;
}) {
  const gt = useGT();
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView
        name="terminal"
        size={12}
        tintColorClassName={props.canRun ? "accent-foreground-muted" : "accent-warning-foreground"}
      />
      <Text
        accessibilityRole={props.canRun ? undefined : "alert"}
        className={
          props.canRun
            ? "min-w-0 flex-1 text-xs text-foreground-muted"
            : "min-w-0 flex-1 text-xs text-warning-foreground"
        }
        numberOfLines={2}
      >
        {props.canRun
          ? gt("Shell command. Runs in the thread's working directory.")
          : gt("Shell commands need terminal access on this connection.")}
      </Text>
      <Button
        label={gt("Exit", { $context: "button that leaves shell mode" })}
        tone="text"
        accessibilityLabel={gt("Exit shell mode")}
        onPress={props.onExit}
      />
    </View>
  );
}
