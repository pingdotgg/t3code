import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { GaugeIcon, PlusIcon } from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsEmptyState, SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState<"cliproxy" | "http" | null>(null);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <div className="flex gap-2">
              <Button size="xs" variant="secondary" onClick={() => setAdding("cliproxy")}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add hub</T>
              </Button>
              <Button size="xs" variant="secondary" onClick={() => setAdding("http")}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add HTTP source</T>
              </Button>
            </div>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <div className="py-8">
            <SettingsEmptyState
              icon={<GaugeIcon />}
              title={gt("No usage sources configured.")}
              description={gt(
                "Add a CLIProxyAPI hub or HTTP quota source to show extra quota next to your providers.",
              )}
            />
          </div>
        ) : (
          entries.map(([id, source]) => {
            const kindLabel = source.kind === "http" ? gt("HTTP quota source") : CLI_PROXY_NAME;
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={
                  <Tooltip>
                    <TooltipTrigger render={<span tabIndex={0} />}>{label}</TooltipTrigger>
                    <TooltipPopup>
                      <span className="block">{kindLabel}</span>
                      {label !== source.url ? <span className="block">{source.url}</span> : null}
                    </TooltipPopup>
                  </Tooltip>
                }
                description={
                  source.enabled ? kindLabel : gt("Disabled", { $context: "provider status" })
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
          kind={adding}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
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
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>The saved connection and its credentials are removed from this environment.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="secondary" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
