import { isManagedSettingPath } from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { ChevronRightIcon } from "lucide-react";

import { useEnvironmentOperateAccess } from "../../hooks/useEnvironmentOperateAccess";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/**
 * Directory defaults for one environment. Inputs hold only what is stored on
 * that server; its own default shows as the placeholder, so an empty field
 * reads as "use the default" and the reset arrow marks an override.
 */
export function EnvironmentDirectoryRows({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const operateAccess = useEnvironmentOperateAccess(environment.environmentId);
  const managedPolicy = environment.serverConfig?.managedPolicy;
  const managed =
    managedPolicy !== undefined && isManagedSettingPath(managedPolicy, "addProjectBaseDirectory")
      ? `Managed by ${managedPolicy.organization}.`
      : undefined;
  const disabledReason =
    environment.connection.phase !== "connected"
      ? "Connect to edit directories."
      : operateAccess === "pending"
        ? "Checking access…"
        : operateAccess !== "granted"
          ? "Your session cannot edit settings."
          : null;
  const disabled = disabledReason !== null;
  // Older servers don't report defaults; Add Project opens at "~/" there.
  const defaults = environment.serverConfig?.environment.defaultDirectories;

  return (
    <>
      <SettingsRow
        title="Repositories directory"
        description="Add Project and Clone Repository start here."
        status={disabledReason}
        aria-disabled={disabled || undefined}
        managed={managed}
        resetAction={
          !disabled && settings.addProjectBaseDirectory !== "" ? (
            <SettingResetButton
              label="repositories directory"
              onClick={() => updateSettings({ addProjectBaseDirectory: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.addProjectBaseDirectory}
            onCommit={(addProjectBaseDirectory) => updateSettings({ addProjectBaseDirectory })}
            normalizeDraft={resolvePastedPath}
            disabled={disabled}
            placeholder={defaults?.repositories ?? "~"}
            spellCheck={false}
            aria-label="Repositories directory"
          />
        }
      />
    </>
  );
}

/** The same rows folded into a remote environment's card. */
export function EnvironmentDirectoryDisclosure({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  return (
    <Collapsible className="mt-3">
      <CollapsibleTrigger
        className="group flex min-h-8 w-full min-w-0 items-center gap-2 text-left"
        aria-label={`Default directories for ${environment.label}`}
      >
        <span className="shrink-0 text-xs text-foreground/70 transition-colors group-hover:text-foreground">
          Default directories
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
          <EnvironmentDirectoryRows environment={environment} />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
