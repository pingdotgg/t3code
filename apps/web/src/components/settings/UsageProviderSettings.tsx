import type { EnvironmentId, UnifiedSettings, UsageLimitSourceConfig } from "@t3tools/contracts";
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
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { withAccountVisibility } from "./usageSourceAccounts";

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
  const updateHubAccounts = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update hub accounts",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const platform = serverConfig?.environment.platform;
  const snapshots = serverConfig?.usageLimitSources ?? [];
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const [savingHubIds, setSavingHubIds] = useState<ReadonlySet<string>>(() => new Set());
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  const setAccountVisible = async (
    id: string,
    source: UsageLimitSourceConfig,
    accountId: string,
    visible: boolean,
  ) => {
    setSavingHubIds((previous) => new Set(previous).add(id));
    await updateHubAccounts({
      environmentId,
      input: {
        patch: {
          usageLimitSources: {
            [id]: {
              ...source,
              hiddenAccounts: withAccountVisibility(source.hiddenAccounts, accountId, visible),
            },
          },
        },
      },
    });
    setSavingHubIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            const snapshot = snapshots.find((candidate) => candidate.id === id);
            const accounts = [...(snapshot?.accounts ?? []), ...(snapshot?.hidden ?? [])];
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
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
              >
                {accounts.length > 0 ? (
                  <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                    {accounts.map((account) => {
                      const title = account.email ?? account.id;
                      return (
                        <div
                          key={account.id}
                          className="flex min-w-0 items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs text-foreground">{title}</p>
                            <p className="truncate text-3xs text-muted-foreground">
                              {providerClients.get(account.driver)?.label ?? String(account.driver)}
                              {account.email ? ` · ${account.id}` : ""}
                            </p>
                          </div>
                          <Switch
                            aria-label={`Show ${title}`}
                            checked={!source.hiddenAccounts.includes(account.id)}
                            disabled={readOnly || savingHubIds.has(id)}
                            onCheckedChange={(visible) =>
                              void setAccountVisible(id, source, account.id, visible)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </SettingsRow>
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
          sources={sources}
        />
      ) : null}
    </>
  );
}

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
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
