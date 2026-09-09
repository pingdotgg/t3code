import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { AddUsageLimitSourceDialog, type UsageLimitSourceKind } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Hub management follows the selected device and access rules of provider settings. */
export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState<UsageLimitSourceKind | null>(null);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="outline" />}>
                <PlusIcon className="size-3" aria-hidden />
                Add source
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setAdding("cliproxy")}>CLIProxyAPI hub</MenuItem>
                <MenuItem onClick={() => setAdding("openrouter")}>OpenRouter</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title="No usage providers configured." />
        ) : (
          entries.map(([id, source]) => {
            const isOpenRouter = source.kind === "openrouter";
            const label = source.label?.trim() || (isOpenRouter ? "OpenRouter" : source.url);
            const url = isOpenRouter ? null : source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {isOpenRouter ? "OpenRouter credits" : "CLI Proxy"}
                    {source.enabled ? "" : " · Disabled"}
                    {url && label !== url ? ` · ${url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      isOpenRouter={isOpenRouter}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding !== null && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={(next) => {
            if (!next) setAdding(null);
          }}
          kind={adding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
        />
      ) : null}
    </>
  );
}

/** Removing a source deletes its stored key, so it requires confirmation. */
function RemoveUsageProviderButton({
  label,
  isOpenRouter,
  onConfirm,
}: {
  readonly label: string;
  readonly isOpenRouter: boolean;
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
              {isOpenRouter
                ? "The API key is deleted from this server. The credit balance leaves the Limits view; your OpenRouter account is untouched. Add the key again to bring it back."
                : "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back."}
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
              {isOpenRouter ? "Remove key" : "Remove hub"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
