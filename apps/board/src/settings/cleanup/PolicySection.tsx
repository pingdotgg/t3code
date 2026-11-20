import type { ServerSettings, WorktreeKeepWhen } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { DaysInput } from "../controls/DaysInput";
import { Select } from "../controls/Select";
import { Switch } from "../controls/Switch";
import { SettingsRow } from "../SettingsRow";
import { SettingsSection } from "../SettingsSection";
import {
  type CleanupMode,
  cleanupValues,
  saveCleanupMode,
  saveCleanupRules,
  type SettingsInput,
} from "../settingsModel";

const MODES: ReadonlyArray<{ value: CleanupMode; title: string }> = [
  { value: "inherit", title: "Inherit" },
  { value: "off", title: "Off" },
  { value: "custom", title: "Custom" },
];

const KEEP_WHEN: ReadonlyArray<{ value: WorktreeKeepWhen; title: string }> = [
  { value: "any-local-files", title: "Any local files" },
  { value: "uncommitted-changes", title: "Uncommitted changes" },
  { value: "tracked-changes", title: "Edited tracked files" },
];

const KEEP_WHEN_NOTE = {
  "any-local-files": "Includes ignored files, except node_modules.",
  "uncommitted-changes": "Keeps edits and untracked files. Deletes ignored files, including .env.",
  "tracked-changes": "Deletes untracked and ignored files, including .env.",
} satisfies Record<WorktreeKeepWhen, string>;

export function PolicySection({
  settings,
  project,
  save,
}: {
  settings: ServerSettings;
  project: EnvironmentProject | null;
  save: (input: SettingsInput) => void;
}) {
  const projectId = project?.id ?? null;
  const { mode, rules, editable } = cleanupValues(settings, projectId);
  const change = (rule: Parameters<typeof saveCleanupRules>[2]) =>
    save(saveCleanupRules(settings, projectId, rule));
  const note =
    mode === "off"
      ? "This project keeps its worktrees until you delete them."
      : mode === "inherit"
        ? "This project follows the rules of All projects."
        : projectId === null && !editable
          ? "A policy on this machine sets these rules."
          : undefined;

  return (
    <SettingsSection title="Automatic cleanup" note={note}>
      {project !== null && (
        <SettingsRow
          title="Automatic worktree cleanup"
          description="Inherit follows All projects. Off keeps this project's worktrees. Custom sets rules for this project."
          control={
            <Select
              label="Automatic worktree cleanup"
              value={mode ?? "inherit"}
              options={MODES}
              onChange={(next) => save(saveCleanupMode(settings, project.id, next))}
            />
          }
        />
      )}
      <SettingsRow
        title="Delete worktrees with deleted threads"
        description="Removes a worktree when its last thread is deleted. Worktrees with local changes are kept."
        control={
          <Switch
            label="Delete worktrees with deleted threads"
            checked={rules.worktreeOnDelete}
            disabled={!editable}
            onChange={(worktreeOnDelete) => change({ worktreeOnDelete })}
          />
        }
      />
      <SettingsRow
        title="Delete merged worktrees"
        description="Removes a worktree whose pull request is merged into the default branch."
        control={
          <Switch
            label="Delete merged worktrees"
            checked={rules.worktreeOnMerge}
            disabled={!editable}
            onChange={(worktreeOnMerge) => change({ worktreeOnMerge })}
          />
        }
      />
      <SettingsRow
        title="Delete inactive worktrees"
        description="Removes a worktree after its threads have been inactive this long."
        control={
          <DaysInput
            label="Delete inactive worktrees"
            value={rules.worktreeAfterDays}
            minimum={1}
            disabled={!editable}
            onCommit={(worktreeAfterDays) => change({ worktreeAfterDays })}
          />
        }
      />
      <SettingsRow
        title="Delete settled worktrees"
        description="Removes a worktree this long after its thread settles. 0 days removes it at the next cleanup."
        control={
          <DaysInput
            label="Delete settled worktrees"
            value={rules.worktreeSettledAfterDays}
            minimum={0}
            disabled={!editable}
            onCommit={(worktreeSettledAfterDays) => change({ worktreeSettledAfterDays })}
          />
        }
      />
      <SettingsRow
        title="Delete unchanged worktrees"
        description="Removes a worktree with no commits beyond the default branch."
        control={
          <Switch
            label="Delete unchanged worktrees"
            checked={rules.worktreeUnchanged}
            disabled={!editable}
            onChange={(worktreeUnchanged) => change({ worktreeUnchanged })}
          />
        }
      />
      <SettingsRow
        title="Keep worktrees with local changes"
        description={KEEP_WHEN_NOTE[rules.worktreeKeepWhen]}
        control={
          <Select
            label="Keep worktrees with local changes"
            value={rules.worktreeKeepWhen}
            options={KEEP_WHEN}
            disabled={!editable}
            onChange={(worktreeKeepWhen) => change({ worktreeKeepWhen })}
          />
        }
      />
    </SettingsSection>
  );
}
