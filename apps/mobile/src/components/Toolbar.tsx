import { GlassContainer } from "expo-glass-effect";
import { NativeHeaderToolbar } from "../native/NativeHeaderToolbar";
import type { ToolbarProps } from "./Toolbar.types";

function ToolbarRoot(props: ToolbarProps) {
  if (props.placement) return <NativeHeaderToolbar {...props} />;
  return (
    <GlassContainer style={{ flexDirection: "row", alignItems: "center" }}>
      {props.children}
    </GlassContainer>
  );
}

export const Toolbar = Object.assign(ToolbarRoot, {
  Button: NativeHeaderToolbar.Button,
  Custom: NativeHeaderToolbar.Custom,
  Label: NativeHeaderToolbar.Label,
  Menu: NativeHeaderToolbar.Menu,
  MenuAction: NativeHeaderToolbar.MenuAction,
  SearchBarSlot: NativeHeaderToolbar.SearchBarSlot,
  Spacer: NativeHeaderToolbar.Spacer,
});
