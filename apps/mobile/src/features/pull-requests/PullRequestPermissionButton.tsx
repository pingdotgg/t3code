import * as Dialog from "../../components/ui/Dialog";
import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";

export function PullRequestPermissionButton({
  reason,
  ...props
}: ComponentProps<typeof Button> & { reason?: string | undefined }) {
  const button = <Button {...props} disabled={props.disabled || Boolean(reason)} />;
  return reason ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}. ${reason}`}
      onPress={() => Dialog.alert("Action unavailable", reason)}
    >
      {button}
    </Pressable>
  ) : (
    button
  );
}
export function PullRequestPermissionIconButton({
  reason,
  ...props
}: ComponentProps<typeof IconButton> & { reason?: string | undefined }) {
  const button = <IconButton {...props} disabled={props.disabled || Boolean(reason)} />;
  return reason ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.accessibilityLabel}. ${reason}`}
      onPress={() => Dialog.alert("Action unavailable", reason)}
    >
      {button}
    </Pressable>
  ) : (
    button
  );
}
