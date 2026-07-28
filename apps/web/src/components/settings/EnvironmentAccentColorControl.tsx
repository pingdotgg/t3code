import type { EnvironmentId } from "@t3tools/contracts";
import { PaletteIcon } from "lucide-react";
import { memo, useCallback } from "react";

import {
  useEnvironmentAccentColor,
  useSetEnvironmentAccentColor,
} from "../../environmentAccentColors";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AccentColorPicker } from "./AccentColorPicker";

/**
 * Compact accent-color control for one environment: a swatch that opens the
 * shared picker. Environment rows are dense and there can be many of them, so
 * the swatch row itself lives in a popover instead of expanding every row.
 */
export const EnvironmentAccentColorControl = memo(function EnvironmentAccentColorControl({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const accentColor = useEnvironmentAccentColor(environmentId);
  const setEnvironmentAccentColor = useSetEnvironmentAccentColor();
  const handleCommit = useCallback(
    (value: string) => {
      setEnvironmentAccentColor(environmentId, value);
    },
    [environmentId, setEnvironmentAccentColor],
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-transform duration-200 hover:scale-105 active:scale-90"
            style={
              accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined
            }
            aria-label={`Accent color for ${label}`}
            data-environment-accent-color={accentColor}
          >
            {accentColor ? null : <PaletteIcon className="size-3.5" aria-hidden />}
          </button>
        }
      />
      <PopoverPopup side="bottom" align="end" sideOffset={6}>
        <AccentColorPicker
          displayName={label}
          value={accentColor}
          onCommit={handleCommit}
          label={null}
          description="Tints this environment's icons in the sidebar and pickers."
          commitDelayMs={120}
        />
      </PopoverPopup>
    </Popover>
  );
});
