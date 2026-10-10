import type { MenuAction } from "@react-native-menu/menu";

import { ControlPill, ControlPillMenu } from "../../components/ControlPill";

const ACTIONS: MenuAction[] = [
  { id: "paste", title: "Paste from clipboard", image: "doc.on.clipboard" },
  { id: "copy", title: "Copy selection", image: "doc.on.doc" },
  { id: "password", title: "Fill password", image: "key" },
];

/**
 * Clipboard and password tools for the page field that has the keyboard. The
 * page runs on the environment, out of reach of this device's paste menu and
 * AutoFill.
 */
export function BrowserClipboardMenu(props: {
  readonly onPaste: () => void;
  readonly onCopy: () => void;
  /** Null on a page without an http(s) origin, which no login belongs to. */
  readonly onFillPassword: (() => void) | null;
}) {
  const { onFillPassword } = props;
  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Clipboard and passwords"
      accessibilityRole="button"
      actions={onFillPassword ? ACTIONS : ACTIONS.filter((action) => action.id !== "password")}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "paste") props.onPaste();
        else if (nativeEvent.event === "copy") props.onCopy();
        else if (nativeEvent.event === "password") onFillPassword?.();
      }}
    >
      <ControlPill
        icon="doc.on.clipboard"
        accessibilityLabel="Clipboard and passwords"
        className="border border-border"
      />
    </ControlPillMenu>
  );
}
