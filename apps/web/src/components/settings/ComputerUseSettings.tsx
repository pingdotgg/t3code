import { MonitorIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function isDesktopHost(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

export function ComputerUseSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const desktop = settings.desktopControl;
  const defaults = DEFAULT_UNIFIED_SETTINGS.desktopControl;
  const onDesktop = isDesktopHost();
  const [binaryHint, setBinaryHint] = useState<string | null>(null);

  useEffect(() => {
    if (!onDesktop) {
      setBinaryHint("Computer Use runs in the T3 Code desktop app on this machine.");
      return;
    }
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) {
      setBinaryHint(
        "Needs macOS Accessibility and Screen Recording permission for this app. Browser control also needs the T3 Code Chrome extension.",
      );
    } else if (platform.includes("win")) {
      setBinaryHint(
        "Uses Windows UI Automation. Browser control needs the T3 Code Chrome extension in your signed-in Chrome.",
      );
    } else {
      setBinaryHint(
        "Uses AT-SPI on Linux (X11). Wayland limits synthetic input. Browser control needs the Chrome extension.",
      );
    }
  }, [onDesktop]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="computer-use"
        title="Computer Use"
        description="Let agents control apps and an agent-owned Chrome tab group on this machine through the local t3-desktop MCP server."
      >
        {!onDesktop ? (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <MonitorIcon className="mt-0.5 size-4 shrink-0" />
            <p>
              You are connected to a remote environment. Computer Use settings apply on the host
              running the T3 Code desktop app.
            </p>
          </div>
        ) : null}

        <SettingsRow
          {...searchableSetting("computer-use-enabled")}
          description="When on, agents get the t3-desktop tools (click, type, screenshot, browser tabs). Turn off to stop injecting that MCP server."
          resetAction={
            desktop.enabled !== defaults.enabled ? (
              <SettingResetButton
                label="computer use"
                onClick={() =>
                  updateSettings({
                    desktopControl: { ...desktop, enabled: defaults.enabled },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={desktop.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  desktopControl: { ...desktop, enabled: Boolean(checked) },
                })
              }
              aria-label="Enable Computer Use"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("computer-use-agent-cursor")}
          description="Show the agent pointer overlay while controlling the desktop so you can see where the agent is working without moving your mouse."
          resetAction={
            desktop.agentCursorEnabled !== defaults.agentCursorEnabled ? (
              <SettingResetButton
                label="agent cursor"
                onClick={() =>
                  updateSettings({
                    desktopControl: {
                      ...desktop,
                      agentCursorEnabled: defaults.agentCursorEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={desktop.agentCursorEnabled}
              disabled={!desktop.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  desktopControl: { ...desktop, agentCursorEnabled: Boolean(checked) },
                })
              }
              aria-label="Show agent cursor overlay"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("computer-use-browser")}
          description="Allow browser_* tools that open and drive tabs in the labelled T3 Code group inside your signed-in Chrome."
          resetAction={
            desktop.browserControlEnabled !== defaults.browserControlEnabled ? (
              <SettingResetButton
                label="browser control"
                onClick={() =>
                  updateSettings({
                    desktopControl: {
                      ...desktop,
                      browserControlEnabled: defaults.browserControlEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={desktop.browserControlEnabled}
              disabled={!desktop.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  desktopControl: {
                    ...desktop,
                    browserControlEnabled: Boolean(checked),
                  },
                })
              }
              aria-label="Enable browser control"
            />
          }
        />

        {binaryHint ? <p className="mt-2 text-sm text-muted-foreground">{binaryHint}</p> : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
