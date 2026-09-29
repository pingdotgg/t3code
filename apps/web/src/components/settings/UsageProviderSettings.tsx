import { translate } from "@t3tools/i18n";
import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Hub management follows the selected device and access rules of provider settings. */
export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    try {
      const result = await updateCursorSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: enabled } },
      });
      if (result._tag === "Success") {
        await refreshProviders({ environmentId, input: {} });
      }
    } finally {
      setUpdatingCursor(false);
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              {translate("settings:addHub", "Add hub")}
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title={translate("common:uiCursorAccountUsage", "Cursor account usage")}
            description={translate(
              "common:uiReadYourExistingCursorCLILoginFrom",
              "Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access.",
            )}
            control={
              <Switch
                aria-label={translate("common:uiCursorAccountUsage", "Cursor account usage")}
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title={translate("settings:noHubsConfigured", "No hubs configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {translate("common:uiCliProxyName", "CLI Proxy")}
                    {source.enabled ? "" : translate("common:uiDisabledSuffix", " · Disabled")}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
        />
      ) : null}
    </>
  );
}

/** Removing a hub deletes its stored management key, so it requires confirmation. */
function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {translate("sidebar:remove", "Remove")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translate("common:uiRemoveLimitSource", "Remove {{source}}?", { source: label })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translate(
                "common:uiRemoveLimitSourceDescription",
                "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {translate("chatView:cancel", "Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {translate("settings:removeHub", "Remove hub")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
