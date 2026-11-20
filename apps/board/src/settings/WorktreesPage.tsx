import type { BranchNamingMode, ServerSettings } from "@t3tools/contracts";

import { Select } from "./controls/Select";
import { TextArea } from "./controls/TextArea";
import { TextInput } from "./controls/TextInput";
import { type Origin, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import {
  type Field,
  type ProjectRef,
  resetOverride,
  saveBranchNaming,
  saveSetupScript,
  saveWorktreesDirectory,
  type SettingsInput,
  worktreeValues,
} from "./settingsModel";

const NAMING_MODES: ReadonlyArray<{ value: BranchNamingMode; title: string }> = [
  { value: "static", title: "Static prefix" },
  { value: "semantic", title: "Semantic prefix" },
  { value: "custom", title: "Custom instructions" },
];

export function WorktreesPage({
  settings,
  project,
  save,
}: {
  settings: ServerSettings;
  project: ProjectRef | null;
  save: (input: SettingsInput) => void;
}) {
  const values = worktreeValues(settings, project);
  const originOf = (
    field: Field<unknown>,
    key:
      | "defaultProjectScripts"
      | "branchNamingMode"
      | "branchNamePrefix"
      | "branchNameInstructions",
  ): Origin | undefined =>
    project === null
      ? undefined
      : {
          inherited: field.inherited,
          onReset: () => save(resetOverride(settings, project.id, [key])),
        };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Creation"
        note={
          project === null
            ? undefined
            : "The location is set for the whole machine. Choose All projects to change it."
        }
      >
        <SettingsRow
          title="Setup script"
          description="Runs in a terminal when T3 creates a worktree for a thread. T3CODE_PROJECT_ROOT and T3CODE_WORKTREE_PATH are set."
          origin={originOf(values.setupScript, "defaultProjectScripts")}
        >
          <TextArea
            label="Setup script"
            mono
            rows={6}
            value={values.setupScript.value}
            placeholder="pnpm install"
            onCommit={(text) => save(saveSetupScript(settings, project, text))}
          />
        </SettingsRow>
        {project === null && (
          <SettingsRow
            title="Location"
            description="Where new worktrees go. Empty uses the worktrees folder of the T3 home directory. Existing worktrees stay where they are."
            control={
              <TextInput
                label="Worktree location"
                value={values.worktreesDirectory}
                placeholder="~/worktrees"
                onCommit={(path) => save(saveWorktreesDirectory(path))}
              />
            }
          />
        )}
      </SettingsSection>
      <SettingsSection title="Branch naming">
        <SettingsRow
          title="Naming"
          description="How T3 names the branch of a new worktree."
          origin={originOf(values.branchNamingMode, "branchNamingMode")}
          control={
            <Select
              label="Worktree branch naming"
              value={values.branchNamingMode.value}
              options={NAMING_MODES}
              onChange={(branchNamingMode) =>
                save(saveBranchNaming(settings, project, { branchNamingMode }))
              }
            />
          }
        />
        {values.branchNamingMode.value === "static" && (
          <SettingsRow
            title="Branch prefix"
            description="For example, t3 or t3/ gives t3/add-search. Empty adds no prefix."
            origin={originOf(values.branchNamePrefix, "branchNamePrefix")}
            control={
              <TextInput
                label="Branch prefix"
                value={values.branchNamePrefix.value}
                placeholder="No prefix"
                className="w-40"
                onCommit={(branchNamePrefix) =>
                  save(saveBranchNaming(settings, project, { branchNamePrefix }))
                }
              />
            }
          />
        )}
        {values.branchNamingMode.value === "custom" && (
          <SettingsRow
            title="Branch naming instructions"
            description="Added to the naming prompt. The model returns the whole branch name."
            origin={originOf(values.branchNameInstructions, "branchNameInstructions")}
          >
            <TextArea
              label="Branch naming instructions"
              value={values.branchNameInstructions.value}
              placeholder="Use julius/ followed by the issue ID and a short description."
              onCommit={(branchNameInstructions) =>
                save(saveBranchNaming(settings, project, { branchNameInstructions }))
              }
            />
          </SettingsRow>
        )}
      </SettingsSection>
    </div>
  );
}
