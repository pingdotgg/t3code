import type { ComponentProps } from "react";

import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { defineNativePluginFeature } from "../../../plugins/features";

function BuiltinSettingsSwitchRow({
  subtitle,
  ...props
}: Omit<ComponentProps<typeof ListToggleRow>, "description"> & {
  readonly subtitle?: string;
}) {
  return <ListToggleRow {...props} description={subtitle} />;
}

export const SettingsSwitchRow = defineNativePluginFeature(
  "native.features.settings.components.settings-switch-row",
  BuiltinSettingsSwitchRow,
);
