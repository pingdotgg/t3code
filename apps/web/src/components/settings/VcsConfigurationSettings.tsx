import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { VcsConfigurationResult, VcsConfigurationWriteInput } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type Setting = VcsConfigurationWriteInput["setting"];
type Entry = VcsConfigurationResult["userName"];

function ConfigurationRow({
  setting,
  title,
  description,
  entry,
  disabled,
  onWrite,
}: {
  setting: Setting;
  title: string;
  description: string;
  entry: Entry;
  disabled: boolean;
  onWrite: (setting: Setting, value: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.repository ?? entry.effective ?? "");
  const hasOverride = entry.repository !== null;
  return (
    <SettingsRow
      title={title}
      description={description}
      status={
        hasOverride
          ? entry.scope === "worktree"
            ? "Worktree override"
            : "Repository override"
          : entry.effective
            ? `Inherited: ${entry.effective}`
            : "Unset"
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="w-44 sm:w-56"
            aria-label={title}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={disabled}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || value.trim() === ""}
            onClick={() => void onWrite(setting, value)}
          >
            Save
          </Button>
          {hasOverride ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void onWrite(setting, null)}
            >
              Reset
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function VcsConfigurationSettingsSection() {
  const { scope } = useSettingsScope();
  const member =
    (scope.kind === "project" || scope.kind === "checkout") && scope.members.length === 1
      ? scope.members[0]!
      : null;
  const status = useEnvironmentQuery(
    member === null
      ? null
      : vcsEnvironment.status({
          environmentId: member.environmentId,
          input: { cwd: member.workspaceRoot },
        }),
  );
  const configuration = useEnvironmentQuery(
    member === null || status.data?.isRepo !== true
      ? null
      : vcsEnvironment.configuration({
          environmentId: member.environmentId,
          input: { cwd: member.workspaceRoot },
        }),
  );
  const writeConfiguration = useAtomCommand(vcsEnvironment.writeConfiguration, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;

  const onWrite = async (setting: Setting, value: string | null) => {
    if (!member) return;
    setSaving(true);
    try {
      const result = await writeConfiguration({
        environmentId: member.environmentId,
        input: { cwd: member.workspaceRoot, setting, value },
      });
      if (result._tag === "Success") {
        configuration.refresh();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update repository configuration",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const config = configuration.data;
  return (
    <SettingsSection title="Repository configuration">
      {member === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Choose one Git checkout to edit its repository configuration.
        </p>
      ) : status.error ? (
        <p className="px-4 py-3 text-sm text-destructive">{status.error}</p>
      ) : status.data?.isRepo === false ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          The selected checkout is not a Git repository.
        </p>
      ) : configuration.error ? (
        <p className="px-4 py-3 text-sm text-destructive">{configuration.error}</p>
      ) : !config ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Loading repository configuration...
        </p>
      ) : (
        <>
          <ConfigurationRow
            key={`${member.environmentId}:${member.workspaceRoot}:name:${config.userName.repository}:${config.userName.effective}`}
            setting="userName"
            title="Commit author name"
            description="Used for new commits in this repository."
            entry={config.userName}
            disabled={saving}
            onWrite={onWrite}
          />
          <ConfigurationRow
            key={`${member.environmentId}:${member.workspaceRoot}:email:${config.userEmail.repository}:${config.userEmail.effective}`}
            setting="userEmail"
            title="Commit author email"
            description="Used for new commits in this repository."
            entry={config.userEmail}
            disabled={saving}
            onWrite={onWrite}
          />
          <ConfigurationRow
            key={`${member.environmentId}:${member.workspaceRoot}:large:${config.largeFile.repository}:${config.largeFile.effective}`}
            setting="largeFile"
            title="Large file diff threshold"
            description="Git treats files above this size as binary in diffs; checkpoints still include them. Enter a size in MiB."
            entry={config.largeFile}
            disabled={saving}
            onWrite={onWrite}
          />
        </>
      )}
    </SettingsSection>
  );
}
