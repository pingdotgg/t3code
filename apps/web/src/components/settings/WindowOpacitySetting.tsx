import type { CSSProperties } from "react";
import { useState } from "react";
import {
  DEFAULT_WINDOW_OPACITY,
  MAX_WINDOW_OPACITY,
  MIN_WINDOW_OPACITY,
} from "@t3tools/contracts/settings";

import { APP_BASE_NAME } from "../../branding";
import { Button } from "../ui/button";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { windowOpacityHint } from "./WindowOpacitySetting.logic";

/** Whole-window opacity. Desktop only: a browser tab cannot make its window see-through. */
export function WindowOpacitySetting() {
  const searchableSetting = useSearchableSetting();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [relaunching, setRelaunching] = useState(false);
  const mode = bridge?.getWindowTransparency?.();
  if (!mode) return null;

  const opacity = settings.windowOpacity;
  const ratio = (opacity - MIN_WINDOW_OPACITY) / (MAX_WINDOW_OPACITY - MIN_WINDOW_OPACITY);
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  const hint = windowOpacityHint({ mode, opacity, appName: APP_BASE_NAME });
  const canRelaunch = mode === "restart-required" && opacity < MAX_WINDOW_OPACITY;

  return (
    <SettingsRow
      {...searchableSetting("setting-window-opacity")}
      description={hint}
      resetAction={
        opacity !== DEFAULT_WINDOW_OPACITY ? (
          <SettingResetButton
            ariaLabel="Reset window transparency"
            onClick={() => updateSettings({ windowOpacity: DEFAULT_WINDOW_OPACITY })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col items-end gap-2 sm:w-52">
          <div className="flex w-full items-center gap-3">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="window-opacity"
            >
              {opacity}%
            </output>
            <input
              aria-label="Window opacity"
              className="settings-slider min-w-0 flex-1"
              id="window-opacity"
              max={MAX_WINDOW_OPACITY}
              min={MIN_WINDOW_OPACITY}
              onChange={(event) => {
                const windowOpacity = Number(event.currentTarget.value);
                if (
                  Number.isInteger(windowOpacity) &&
                  windowOpacity >= MIN_WINDOW_OPACITY &&
                  windowOpacity <= MAX_WINDOW_OPACITY
                ) {
                  updateSettings({ windowOpacity });
                }
              }}
              step={5}
              style={sliderStyle}
              type="range"
              value={opacity}
            />
          </div>
          {canRelaunch && bridge?.relaunchForWindowOpacity ? (
            <Button
              disabled={relaunching}
              size="xs"
              variant="outline"
              onClick={() => {
                setRelaunching(true);
                void bridge.relaunchForWindowOpacity?.().catch(() => setRelaunching(false));
              }}
            >
              {relaunching ? "Restarting…" : `Restart ${APP_BASE_NAME}`}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
