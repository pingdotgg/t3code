import { useAtom } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import {
  loadsPluginUi,
  pluginUiChoicesAtom,
  withPluginUiChoice,
} from "../../../plugins/pluginFollow";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../../state/environments";
import { Button } from "../../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { settingsScopeEnvironmentLabel } from "../settingsScopeAxis";
import { SettingsRow } from "../settingsLayout";
import { runsPlugins } from "./pluginTargets";

/**
 * Turns plugin UI on or off for each environment in this browser. The main environment starts on
 * and the others off; hidden while the main environment is the only one that could supply it.
 */
export function PluginUiEnvironmentRow() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [choices, setChoices] = useAtom(pluginUiChoicesAtom);
  const isOn = (environmentId: EnvironmentId) =>
    loadsPluginUi(choices, environmentId, primaryEnvironmentId);
  // A chosen environment stays listed while it is offline, so it can be turned off.
  const options = environments.filter(
    (environment) => runsPlugins(environment) || isOn(environment.environmentId),
  );
  if (
    primaryEnvironmentId !== null &&
    options.every((option) => option.environmentId === primaryEnvironmentId)
  ) {
    return null;
  }
  const labelOf = (environment: EnvironmentPresentation) =>
    settingsScopeEnvironmentLabel(environment, environments);
  const chosenLabels = options.filter((option) => isOn(option.environmentId)).map(labelOf);
  return (
    <SettingsRow
      title="Load plugin UI from"
      description={
        chosenLabels.length < 2
          ? "The chosen servers' plugins run code in this window."
          : "The chosen servers' plugins run code in this window. A plugin on in more than one adds its commands and styles once."
      }
      control={
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" className="w-full sm:w-48" />}
            aria-label="Load plugin UI from"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {chosenLabels.length === 0 ? "None" : chosenLabels.join(", ")}
            </span>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {options.map((option) => (
              <MenuCheckboxItem
                key={option.environmentId}
                variant="switch"
                checked={isOn(option.environmentId)}
                onCheckedChange={(on) =>
                  setChoices(
                    withPluginUiChoice(choices, option.environmentId, on, primaryEnvironmentId),
                  )
                }
              >
                {labelOf(option)}
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </Menu>
      }
    />
  );
}
