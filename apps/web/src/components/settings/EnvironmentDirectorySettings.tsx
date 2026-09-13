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
  const disabledReason =
    environment.connection.phase !== "connected"
      ? "Connect to edit directories."
      : operateAccess === "pending"
        ? "Checking access…"
        : operateAccess !== "granted"
          ? "Your session cannot edit settings."
          : null;
  const disabled = disabledReason !== null;
  const supportsWorktreeDirectory =
    environment.serverConfig?.environment.capabilities.worktreeBaseDirectory === true;
  // Older servers don't report defaults; Add Project opens at "~/" there.
  const defaults = environment.serverConfig?.environment.defaultDirectories;

  return (
    <>
      <SettingsRow
        title="Repositories directory"
        description="Add Project and Clone Repository start here."
        status={disabledReason}
        aria-disabled={disabled || undefined}
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
            disabled={disabled}
            placeholder={defaults?.repositories ?? "~"}
            spellCheck={false}
            aria-label="Repositories directory"
          />
        }
      />
      <SettingsRow
        title="Worktrees directory"
        description={
          supportsWorktreeDirectory
            ? "New worktrees only. Existing worktrees stay where they are."
            : "Update this server to set a worktrees directory."
        }
        status={disabledReason}
        aria-disabled={disabled || !supportsWorktreeDirectory || undefined}
        resetAction={
          !disabled && supportsWorktreeDirectory && settings.worktreeBaseDirectory !== "" ? (
            <SettingResetButton
              label="worktrees directory"
              onClick={() => updateSettings({ worktreeBaseDirectory: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.worktreeBaseDirectory}
            onCommit={(worktreeBaseDirectory) => updateSettings({ worktreeBaseDirectory })}
            disabled={disabled || !supportsWorktreeDirectory}
            placeholder={defaults?.worktrees ?? "T3 Code default"}
            spellCheck={false}
            aria-label="Worktrees directory"
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
