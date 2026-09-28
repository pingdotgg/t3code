import type { NativeHeaderToolbar as IosNativeHeaderToolbar } from "./NativeHeaderToolbar";

function NativeHeaderToolbarRoot(_props: Parameters<typeof IosNativeHeaderToolbar>[0]) {
  return null;
}

function NativeHeaderToolbarButton(_props: Parameters<typeof IosNativeHeaderToolbar.Button>[0]) {
  return null;
}

function NativeHeaderToolbarMenu(_props: Parameters<typeof IosNativeHeaderToolbar.Menu>[0]) {
  return null;
}

function NativeHeaderToolbarMenuAction(
  _props: Parameters<typeof IosNativeHeaderToolbar.MenuAction>[0],
) {
  return null;
}

function NativeHeaderToolbarLabel(_props: Parameters<typeof IosNativeHeaderToolbar.Label>[0]) {
  return null;
}

function NativeHeaderToolbarSpacer(_props: Parameters<typeof IosNativeHeaderToolbar.Spacer>[0]) {
  return null;
}

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}

// Native header item factories are iOS-only; Android owns its in-flow header.
export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
