import type { NativeHeaderToolbar as IosNativeHeaderToolbar } from "./NativeHeaderToolbar";
import { defineNativePluginFeature } from "../plugins/features";

const NativeHeaderToolbarRoot = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-root",
  BuiltinNativeHeaderToolbarRoot,
);

const NativeHeaderToolbarButton = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-button",
  BuiltinNativeHeaderToolbarButton,
);

const NativeHeaderToolbarMenu = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-menu",
  BuiltinNativeHeaderToolbarMenu,
);

const NativeHeaderToolbarMenuAction = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-menu-action",
  BuiltinNativeHeaderToolbarMenuAction,
);

const NativeHeaderToolbarLabel = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-label",
  BuiltinNativeHeaderToolbarLabel,
);

const NativeHeaderToolbarSpacer = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-spacer",
  BuiltinNativeHeaderToolbarSpacer,
);

const NativeHeaderToolbarSearchBarSlot = defineNativePluginFeature(
  "native.native.native-header-toolbar.native-header-toolbar-search-bar-slot",
  BuiltinNativeHeaderToolbarSearchBarSlot,
);

function BuiltinNativeHeaderToolbarRoot(_props: Parameters<typeof IosNativeHeaderToolbar>[0]) {
  return null;
}

function BuiltinNativeHeaderToolbarButton(
  _props: Parameters<typeof IosNativeHeaderToolbar.Button>[0],
) {
  return null;
}

function BuiltinNativeHeaderToolbarMenu(_props: Parameters<typeof IosNativeHeaderToolbar.Menu>[0]) {
  return null;
}

function BuiltinNativeHeaderToolbarMenuAction(
  _props: Parameters<typeof IosNativeHeaderToolbar.MenuAction>[0],
) {
  return null;
}

function NativeHeaderToolbarCustom(_props: Parameters<typeof IosNativeHeaderToolbar.Custom>[0]) {
  return null;
}

function BuiltinNativeHeaderToolbarLabel(
  _props: Parameters<typeof IosNativeHeaderToolbar.Label>[0],
) {
  return null;
}

function BuiltinNativeHeaderToolbarSpacer(
  _props: Parameters<typeof IosNativeHeaderToolbar.Spacer>[0],
) {
  return null;
}

function BuiltinNativeHeaderToolbarSearchBarSlot() {
  return null;
}

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Custom: NativeHeaderToolbarCustom,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
