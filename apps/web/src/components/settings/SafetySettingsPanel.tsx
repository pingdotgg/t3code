import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const ORCHESTRATION_EVENTS_ENDPOINT_PATH = "/api/orchestration/events";

export function SafetySettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Event stream URL copied",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy event stream URL",
          description: error.message,
        }),
      );
    },
  });

  const protectedPathsEnabled = settings.safety.protectedFilesystemPathsEnabled;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Filesystem">
        <SettingsRow
          title="Protected paths"
          description="Skip OS-sensitive folders during browse and workspace scans."
          resetAction={
            protectedPathsEnabled !==
            DEFAULT_UNIFIED_SETTINGS.safety.protectedFilesystemPathsEnabled ? (
              <SettingResetButton
                label="protected paths"
                onClick={() =>
                  updateSettings({
                    safety: {
                      protectedFilesystemPathsEnabled:
                        DEFAULT_UNIFIED_SETTINGS.safety.protectedFilesystemPathsEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={protectedPathsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  safety: {
                    protectedFilesystemPathsEnabled: Boolean(checked),
                  },
                })
              }
              aria-label="Protected paths"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Event stream"
          description="Authenticated read-only stream for debugging orchestration events."
          status={
            <span className="text-code-compact block break-all font-mono text-foreground">
              {ORCHESTRATION_EVENTS_ENDPOINT_PATH}
            </span>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => copyToClipboard(ORCHESTRATION_EVENTS_ENDPOINT_PATH, undefined)}
            >
              {isCopied ? "Copied" : "Copy URL"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
