import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./ProjectSettingsPanel";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettingSource } from "./useScopedSettings";

/**
 * Environment scopes edit the actions every inheriting project gets; project
 * scopes edit that project's override on each selected environment. Shortcuts
 * are environment-wide, so the same action id shares its binding on an environment.
 */
export function ProjectDefaultActionsSettings() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const source = useScopedSettingSource(["defaultProjectScripts"]);
  const representativeConfig = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
        ?.serverConfig
    : undefined;
  const scripts = target?.settings.defaultProjectScripts ?? [];
  const keybindings = representativeConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const mixed = targets.some(
    (candidate) =>
      JSON.stringify(candidate.settings.defaultProjectScripts) !== JSON.stringify(scripts),
  );
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const memberById = new Map(
    isProjectScope ? scope.members.map((member) => [member.id, member]) : [],
  );
  const { saving, persist, submit } = useProjectScriptSettings(
    targets.flatMap((candidate) => {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      if (!environment?.serverConfig) return [];
      const member = candidate.projectId ? memberById.get(candidate.projectId) : undefined;
      return [
        {
          environmentId: candidate.environmentId,
          // Writes read the raw environment settings so an override entry is
          // extended, not derived from already-resolved values.
          settings: environment.serverConfig.settings,
          keybindings: environment.serverConfig.keybindings,
          ...(member ? { project: member } : {}),
        },
      ];
    }),
  );

  return (
    <SettingsSection id="project-actions" title="Actions">
      <SettingsRow
        title={isProjectScope ? "Project actions" : "Default actions"}
        description={
          isProjectScope
            ? source === "project"
              ? "Overridden for this project. Commands run in the checkout or its worktree."
              : "Inherited from the environment's default actions. Adding an action creates an independent list for this project."
            : "Available in every inheriting checkout. Commands run in that checkout or its worktree."
        }
        resetAction={
          isProjectScope ? (
            source === "project" || source === "mixed" ? (
              <SettingResetButton
                label="project actions"
                tooltip="Reset to inherited actions"
                disabled={saving}
                onClick={() => void persist(() => null)}
              />
            ) : null
          ) : targets.some((candidate) => candidate.settings.defaultProjectScripts.length > 0) ? (
            <SettingResetButton
              label="default actions"
              disabled={saving}
              onClick={() => void persist(() => [])}
            />
          ) : null
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={saving || targets.length === 0}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Select one environment to edit its actions. Adding an action applies to every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={keybindings}
          disabled={saving}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        />
      )}
      <ProjectScriptEditorDialog
        request={request}
        scripts={scripts}
        onSubmit={submit}
        onDelete={(id) =>
          void persist((current) => current.filter((script) => script.id !== id), id, null)
        }
        onClose={() => setRequest(null)}
      />
    </SettingsSection>
  );
}
