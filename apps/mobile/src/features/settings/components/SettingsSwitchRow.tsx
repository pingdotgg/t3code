import type { ComponentProps } from "react";

import { ListToggleRow } from "../../../components/ListToggleRow";

export function SettingsSwitchRow({
  subtitle,
  ...props
}: Omit<ComponentProps<typeof ListToggleRow>, "description"> & {
  readonly subtitle?: string;
}) {
  return <ListToggleRow {...props} description={subtitle} />;
}
