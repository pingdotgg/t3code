import { useState } from "react";
import { View } from "react-native";

import { IconButton } from "../../components/ui/IconButton";
import { MenuPopup } from "../../components/ui/MenuPopup.android";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import type { RegisteredServerMenuProps } from "./RegisteredServerMenu";

export function RegisteredServerMenu(props: RegisteredServerMenuProps) {
  const { buttonSize, menuWidth } = useAndroidControlSizing();
  const [open, setOpen] = useState(false);
  if (open && props.disabled) setOpen(false);

  const close = () => setOpen(false);

  // Clerk's Compose host offsets RN window coordinates, so anchor the popup within the button's view.
  return (
    <View collapsable={false} style={{ width: buttonSize, height: buttonSize }}>
      <IconButton
        accessibilityLabel={props.accessibilityLabel}
        disabled={props.disabled}
        icon="ellipsis"
        tintColorClassName="accent-clerk-foreground-muted"
        onPress={() => setOpen(true)}
      />
      {open ? (
        <MenuPopup
          anchor={{ x: 0, y: 0, width: buttonSize, height: buttonSize }}
          menuWidth={menuWidth}
          actions={props.actions}
          parent={null}
          onBack={close}
          onClose={close}
          onPress={() => {
            close();
            props.onPressAction();
          }}
        />
      ) : null}
    </View>
  );
}
