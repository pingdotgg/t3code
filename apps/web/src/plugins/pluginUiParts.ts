import { PluginPanelLauncherItems, PluginPanelMenuItems } from "./PluginPanelMenuItems";
import {
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginComposerCollapseOnScrollAtom,
  pluginPartReplacedAtoms,
} from "./pluginRegistry";
import { PluginReplaceable } from "./PluginReplaceable";

export const pluginUi = {
  PluginPanelLauncherItems,
  PluginPanelMenuItems,
  pluginCommandLabel,
  pluginCommandsAtom,
  pluginComposerCollapseOnScrollAtom,
  pluginPartReplacedAtoms,
  PluginReplaceable,
};

export type PluginUi = typeof pluginUi;
