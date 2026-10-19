import { View } from "react-native";

import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import type { SheetCloseButtonProps, SheetHeaderProps } from "./SheetHeader.types";

export function SheetCloseButton(props: SheetCloseButtonProps) {
  return (
    <IconButton
      icon="xmark"
      accessibilityLabel={props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close")}
      disabled={props.disabled}
      tintColorClassName="accent-header-foreground"
      onPress={props.onCancel ?? props.onClose}
    />
  );
}

export function SheetHeader(props: SheetHeaderProps) {
  const confirmation = props.confirm;
  const trailing =
    props.trailing || confirmation ? (
      <View className="flex-row items-center gap-2">
        {props.trailing}
        {confirmation ? (
          <Button
            label={confirmation.label}
            tone="text"
            loading={confirmation.loading}
            disabled={confirmation.disabled}
            onPress={confirmation.onPress}
          />
        ) : null}
      </View>
    ) : undefined;

  return (
    <AndroidScreenHeader
      embedded={props.presentation === "inline"}
      title={props.title}
      subtitle={props.subtitle}
      leading={
        <SheetCloseButton
          {...(props.onCancel ? { onCancel: props.onCancel } : { onClose: props.onClose })}
          accessibilityLabel={props.accessibilityLabel}
          disabled={props.dismissDisabled}
        />
      }
      trailing={trailing}
      hideBottomBorder
    />
  );
}
