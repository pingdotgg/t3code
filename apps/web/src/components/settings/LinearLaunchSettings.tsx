import type { LinearConnectionStatus, LinearDefaultWorkspace } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { LinearGlyph } from "../linear/linearIcons";
import { useLinearEnvironmentId, useLinearTeamMetadata } from "../linear/useLinearData";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { firstStartedStateName } from "./linearSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DEFAULT_STATE_VALUE = "default";

const WORKSPACE_LABELS: Readonly<Record<LinearDefaultWorkspace, string>> = {
  worktree: "New worktree · Linear branch name",
  local: "Local checkout",
};

const INCLUDE_OPTIONS = [
  { key: "includeSubIssues", label: "Sub-issues" },
  { key: "includeComments", label: "Comments" },
  { key: "includeLinkedPrs", label: "Linked PRs" },
] as const;

export function LinearLaunchSettings({ status }: { readonly status: LinearConnectionStatus }) {
  const environmentId = useLinearEnvironmentId();
  if (environmentId === null) return null;
  return <LaunchSection environmentId={environmentId} status={status} />;
}

function LaunchSection({
  environmentId,
  status,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof useLinearEnvironmentId>>;
  readonly status: LinearConnectionStatus;
}) {
  const linear = useEnvironmentSettings(environmentId, (settings) => settings.linear);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  // States belong to a team; list the first mapped team's, else the first visible team's.
  const referenceTeamId =
    linear.mappings.find((mapping) => mapping.kind === "team")?.linearId ?? status.teams[0]?.id;
  const metadata = useLinearTeamMetadata(referenceTeamId).data;
  const startedStates = (metadata?.states ?? [])
    .filter((state) => state.type === "started")
    .toSorted((left, right) => left.position - right.position);
  const defaultStateName = firstStartedStateName(metadata?.states ?? []) ?? "In Progress";
  const selectedState = startedStates.find((state) => state.id === linear.moveToStateId);

  return (
    <SettingsSection {...searchableSetting("linear-launch")} title="When launching from an issue">
      <SettingsRow
        title="Move issue to a state"
        description="When a chat or pipeline starts, move the issue so your team sees it's being worked on. Only applies to issues in Backlog, Triage or Todo."
        control={
          <div className="flex items-center gap-2.5">
            <Select
              value={linear.moveToStateId ?? DEFAULT_STATE_VALUE}
              onValueChange={(value) =>
                updateSettings({
                  linear: { moveToStateId: value === DEFAULT_STATE_VALUE ? null : value },
                })
              }
            >
              <SelectTrigger size="sm" aria-label="State to move issues to" className="min-w-36">
                <SelectValue>{() => selectedState?.name ?? defaultStateName}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT_STATE_VALUE}>
                  {defaultStateName} (team default)
                </SelectItem>
                {startedStates
                  .filter((state) => state.name !== defaultStateName)
                  .map((state) => (
                    <SelectItem key={state.id} value={state.id}>
                      {state.name}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
            <Switch
              aria-label="Move issue to a state"
              checked={linear.moveToStateEnabled}
              onCheckedChange={(enabled) =>
                updateSettings({ linear: { moveToStateEnabled: enabled } })
              }
            />
          </div>
        }
      />
      <SettingsRow
        title="Comment with a link to the thread"
        description="Posts “started a T3 Code chat / pipeline” with a link that opens the thread. Pipelines post one comment and edit it as steps finish."
        control={
          <Switch
            aria-label="Comment with a link to the thread"
            checked={linear.commentEnabled}
            onCheckedChange={(enabled) => updateSettings({ linear: { commentEnabled: enabled } })}
          />
        }
      />
      <SettingsRow
        title="Link the pull request back"
        description={
          <>
            Nothing to do here: Linear links a PR to its issue automatically when the branch name
            contains the issue ID, like{" "}
            <code className="rounded bg-muted px-1 font-mono text-2xs">jan/att-612-rfid-apdu</code>.
            New worktrees use Linear&apos;s branch name to get this for free.
          </>
        }
        control={
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
            <LinearGlyph className="size-3" />
            Automatic in Linear
          </span>
        }
      />
      <SettingsRow
        title="Default workspace"
        description="Where a chat started from an issue runs. You can change it per launch."
        control={
          <Select
            value={linear.defaultWorkspace}
            onValueChange={(value) => {
              if (value === "worktree" || value === "local")
                updateSettings({ linear: { defaultWorkspace: value } });
            }}
          >
            <SelectTrigger size="sm" aria-label="Default workspace">
              <SelectValue>
                {(value: LinearDefaultWorkspace) => WORKSPACE_LABELS[value]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="worktree">{WORKSPACE_LABELS.worktree}</SelectItem>
              <SelectItem value="local">{WORKSPACE_LABELS.local}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Include in context by default"
        description="What an agent receives along with the issue. You can change it per launch."
        control={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {INCLUDE_OPTIONS.map((option) => (
              <label key={option.key} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <Checkbox
                  checked={linear[option.key]}
                  onCheckedChange={(checked) =>
                    updateSettings({ linear: { [option.key]: checked === true } })
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
        }
      />
    </SettingsSection>
  );
}
