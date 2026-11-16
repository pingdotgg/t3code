import type { ServerSettings } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";

import { Switch } from "../ui/switch";
import { useScopedSettingsMixed } from "./useScopedSettings";

/**
 * A mixed switch flips the value last picked on it, so a pick that some environments dropped can
 * be undone. Before any pick, it turns the setting on everywhere.
 */
export function ScopedSwitch({
  settingKeys,
  checked,
  onCheckedChange,
  ...props
}: ComponentProps<typeof Switch> & { settingKeys: readonly (keyof ServerSettings)[] }) {
  const mixed = useScopedSettingsMixed(settingKeys);
  const [picked, setPicked] = useState(false);
  return (
    <Switch
      {...props}
      mixed={mixed}
      checked={mixed ? picked : checked}
      onCheckedChange={(next, details) => {
        setPicked(next);
        onCheckedChange?.(next, details);
      }}
    />
  );
}
