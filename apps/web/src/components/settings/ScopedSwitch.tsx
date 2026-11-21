import type { ServerSettings } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";

import { Switch } from "../ui/switch";
import { useScopedSettingsMixed } from "./useScopedSettings";

/**
 * A mixed switch flips the value last picked on it, so a pick that some environments dropped can
 * be undone. Before any pick, it turns the setting on everywhere.
 */
export function ScopedSwitch({
  settingKeys = [],
  mixed: mixedOverride,
  checked,
  onCheckedChange,
  ...props
}: ComponentProps<typeof Switch> & { settingKeys?: readonly (keyof ServerSettings)[] }) {
  const keysMixed = useScopedSettingsMixed(settingKeys);
  const mixed = mixedOverride ?? keysMixed;
  const [picked, setPicked] = useState(false);
  return (
    <Switch
      {...props}
      mixed={mixed}
      checked={mixed ? false : checked}
      onCheckedChange={(next, details) => {
        const value = mixed ? !picked : next;
        setPicked(value);
        onCheckedChange?.(value, details);
      }}
    />
  );
}
