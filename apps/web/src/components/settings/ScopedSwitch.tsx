import type { ServerSettings } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { Switch } from "../ui/switch";
import { useScopedSettingsMixed } from "./useScopedSettings";

/**
 * A switch for a server setting that renders the mixed state when the
 * selected targets disagree on `settingKeys`. Clicking a mixed switch turns
 * it on everywhere, the macOS mixed-checkbox convention.
 */
export function ScopedSwitch({
  settingKeys,
  checked,
  ...props
}: ComponentProps<typeof Switch> & { settingKeys: readonly (keyof ServerSettings)[] }) {
  const mixed = useScopedSettingsMixed(settingKeys);
  return <Switch {...props} mixed={mixed} checked={mixed ? false : checked} />;
}
