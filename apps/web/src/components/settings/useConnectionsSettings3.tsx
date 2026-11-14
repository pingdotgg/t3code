import type { ConnectionsSettingsProps } from "./connectionsSettingsTypes";
import { useConnectionsSettings1 } from "./useConnectionsSettings1";
import { useConnectionsSettings2 } from "./useConnectionsSettings2";

import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";


// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";

const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

export function useConnectionsSettings3(props: ConnectionsSettingsProps, params: {
  s1: ReturnType<typeof useConnectionsSettings1>,
  s2: ReturnType<typeof useConnectionsSettings2>,
  }) {
  const { s1, s2 } = params;
  const { desktopWslState, desktopWslError, canManageLocalBackend, isLoadingWslState, isUpdatingWslBackend } = s1;
  const { loadWslState, handleSelectWslMode, handleToggleWslOnly } = s2;
    const renderWslRow = () => {
      if (!desktopWslState) {
        if (
          isWslSettingsRowVisible({ state: null, error: desktopWslError }) &&
          canManageLocalBackend
        ) {
          return (
            <SettingsRow
              {...searchableSetting("wsl-backend")}
              description="Couldn't load the WSL backend state."
              status={<span className="block text-destructive">{desktopWslError}</span>}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={loadWslState}
                  disabled={isLoadingWslState}
                >
                  {isLoadingWslState ? "Retrying…" : "Retry"}
                </Button>
              }
            />
          );
        }
        return null;
      }
      if (!isWslSettingsRowVisible({ state: desktopWslState, error: desktopWslError })) {
        return null;
      }
      if (!desktopWslState.available) {
        return (
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description="WSL is unavailable, so Windows is running instead. Turn WSL off to clear this preference."
            status={
              desktopWslError ? (
                <span className="block text-destructive">{desktopWslError}</span>
              ) : null
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdatingWslBackend}
                onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
              >
                Switch to Windows
              </Button>
            }
          />
        );
      }
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      const selectValue = !desktopWslState.enabled
        ? BACKEND_VALUE_WSL_OFF
        : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
      const selectLabel =
        selectValue === BACKEND_VALUE_WSL_OFF
          ? "Off"
          : selectValue === BACKEND_VALUE_DEFAULT_WSL
            ? "Default distro"
            : selectValue;
      return (
        <>
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description="Run the selected WSL distro alongside Windows. Projects remain on their current filesystem."
            status={
              desktopWslError ? (
                <span className="block text-destructive">{desktopWslError}</span>
              ) : desktopWslState.preflightError ? (
                <span className="block text-destructive">
                  WSL backend couldn't start: {desktopWslState.preflightError}
                </span>
              ) : null
            }
            control={
              <Select
                value={selectValue}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  handleSelectWslMode(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="WSL backend"
                  disabled={isUpdatingWslBackend}
                >
                  <SelectValue>{selectLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                    Off
                  </SelectItem>
                  {desktopWslState.distros.length === 0 ? (
                    <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                      Default distro
                    </SelectItem>
                  ) : (
                    desktopWslState.distros.map((distro) => (
                      <SelectItem hideIndicator key={distro.name} value={distro.name}>
                        {distro.name}
                        {distro.isDefault ? " (default)" : ""}
                      </SelectItem>
                    ))
                  )}
                </SelectPopup>
              </Select>
            }
          />
          {desktopWslState.enabled ? (
            <SettingsRow
              title="WSL only"
              description="Run only the WSL backend. T3 Code restarts when this changes."
              className="bg-muted/20 pl-7 sm:pl-8"
              control={
                <Switch
                  checked={desktopWslState.wslOnly}
                  disabled={isUpdatingWslBackend}
                  onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                  aria-label="Run WSL only"
                />
              }
            />
          ) : null}
        </>
      );
    };

  return { renderWslRow };
}
