// Everything the page only needs when a native shell hosts it. Imported
// through `./lazy` (components) or a dynamic import (context menu) so none of
// it, nor the shell schemas, lands in the browser bundle.
export { ShellComposerBridge } from "./ShellComposerBridge";
export { ShellEmbedRouteBridge } from "./ShellEmbedRouteBridge";
export { ShellGitBridge } from "./ShellGitBridge";
export { ShellLayoutBridge } from "./ShellLayoutBridge";
export { ShellRightPanelBridge } from "./ShellRightPanelBridge";
export { ShellSettingsBridge } from "./ShellSettingsBridge";
export { ShellThemeBridge } from "./ShellThemeBridge";
export { ShellToastBridge } from "./ShellToastBridge";
export { ShellWorkspaceBridge } from "./ShellWorkspaceBridge";
export { T3ShellBridge } from "./T3ShellBridge";
export { closeShellContextMenu, showShellContextMenu } from "./shellContextMenu";
