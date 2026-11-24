import type { AppleIntentStatus } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import { clearDesktopAppleIntentsIndex } from "../desktop/DesktopAppleIntentsCoordinator";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function AppleIntentsSettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const appleIntentsEnabled = useClientSettings((settings) => settings.appleIntentsEnabled);
  const appleIntentsIndexMessagePreviews = useClientSettings(
    (settings) => settings.appleIntentsIndexMessagePreviews,
  );
  const [status, setStatus] = useState<AppleIntentStatus | null>(null);
  const [clearing, setClearing] = useState(false);

  const bridge =
    typeof window !== "undefined" && isMacPlatform(navigator.platform)
      ? window.desktopBridge?.appleIntents
      : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queries native macOS Apple Intents availability from the Electron preload bridge
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .getStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch(() => {
        if (active) setStatus({ available: false, reason: "native-bridge-unavailable" });
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge) {
    return null;
  }

  const reportClearFailure = () =>
    toastManager.add({
      type: "error",
      title: gt("Could not clear Siri & Spotlight index"),
      description: gt("Indexed threads may still appear in Spotlight. Try clearing it again."),
    });

  const handleClearIndex = () => {
    if (clearing) return;
    setClearing(true);
    void clearDesktopAppleIntentsIndex()
      .then(() => {
        setClearing(false);
        toastManager.add({
          type: "success",
          title: gt("Siri & Spotlight index cleared"),
          description: gt("Indexed projects, threads, and cached credentials were removed."),
        });
      })
      .catch(() => {
        setClearing(false);
        reportClearFailure();
      });
  };

  if (status !== null && !status.available) {
    return (
      <SettingsSection id="apple-intents" title={gt("Siri & Spotlight")}>
        <SettingsRow
          {...setting("apple-intents-enabled")}
          devicePreference
          description={
            status.reason === "requires-macos-27.3" ? (
              <T>Siri & Spotlight App Intents require macOS 27.3 or later.</T>
            ) : (
              <T>
                The native Apple Intents extension is unavailable in this build. Use a packaged
                macOS build created with Xcode 27.3 or later.
              </T>
            )
          }
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="apple-intents" title={gt("Siri & Spotlight")}>
      <SettingsRow
        {...setting("apple-intents-enabled")}
        devicePreference
        description={
          <T>
            Index projects and threads on this Mac so Siri, Shortcuts, and Spotlight can find,
            summarize, and open them.
          </T>
        }
        resetAction={
          appleIntentsEnabled !== DEFAULT_CLIENT_SETTINGS.appleIntentsEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset Siri & Spotlight indexing to default")}
              onClick={() => {
                void persistClientSettingsPatch({
                  appleIntentsEnabled: DEFAULT_CLIENT_SETTINGS.appleIntentsEnabled,
                });
              }}
            />
          ) : null
        }
        control={
          <Switch
            checked={appleIntentsEnabled}
            onCheckedChange={(checked) => {
              if (checked) {
                void persistClientSettingsPatch({ appleIntentsEnabled: true });
                return;
              }
              // Save the opt-out only once the index is gone, so a cut-short clear stays visible.
              void clearDesktopAppleIntentsIndex().then(
                () => persistClientSettingsPatch({ appleIntentsEnabled: false }),
                reportClearFailure,
              );
            }}
            aria-label={gt("Index for Siri & Spotlight")}
          />
        }
      />
      <SettingsRow
        {...setting("apple-intents-message-previews")}
        devicePreference
        description={
          <T>Include short sanitized previews of the latest message in Spotlight results.</T>
        }
        resetAction={
          appleIntentsIndexMessagePreviews !==
          DEFAULT_CLIENT_SETTINGS.appleIntentsIndexMessagePreviews ? (
            <SettingResetButton
              ariaLabel={gt("Reset Spotlight message previews to default")}
              onClick={() => {
                void persistClientSettingsPatch({
                  appleIntentsIndexMessagePreviews:
                    DEFAULT_CLIENT_SETTINGS.appleIntentsIndexMessagePreviews,
                });
              }}
            />
          ) : null
        }
        control={
          <Switch
            checked={appleIntentsIndexMessagePreviews}
            disabled={!appleIntentsEnabled}
            onCheckedChange={(checked) => {
              void persistClientSettingsPatch({
                appleIntentsIndexMessagePreviews: Boolean(checked),
              });
            }}
            aria-label={gt("Include message previews")}
          />
        }
      />
      <SettingsRow
        {...setting("apple-intents-clear-index")}
        devicePreference
        description={
          <T>
            Remove all indexed threads, projects, and cached credentials from Siri and Spotlight on
            this Mac.
          </T>
        }
        control={
          <Button variant="outline" size="sm" disabled={clearing} onClick={handleClearIndex}>
            {clearing ? <T>Clearing…</T> : <T>Clear index</T>}
          </Button>
        }
      />
    </SettingsSection>
  );
}
