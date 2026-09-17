import { Pressable } from "react-native";
import { AppText } from "./AppText";

export interface MaterialButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly tone?: "primary" | "secondary" | "danger" | "text";
  readonly fullWidth?: boolean;
}

export function MaterialButton(props: MaterialButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-12 justify-center rounded-full bg-secondary px-6"
    >
      <AppText>{props.label}</AppText>
    </Pressable>
  );
}
