import type { EnvironmentId } from "@t3tools/contracts";
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

export function ProjectDefaultActionsSettings({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const targets = environments.filter(
    (environment) =>
      (environmentId === null || environment.environmentId === environmentId) &&
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null,
  );
  const representative = targets[0]?.serverConfig;
  const scripts = representative?.settings.defaultProjectScripts ?? [];
  const keybindings = representative?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const mixed = targets.some(
    (target) =>
      JSON.stringify(target.serverConfig?.settings.defaultProjectScripts) !==
      JSON.stringify(scripts),
  );
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const { saving, persist, submit } = useProjectScriptSettings(
    targets.flatMap(({ environmentId, serverConfig }) =>
      serverConfig
        ? [
            {
              environmentId,
              settings: serverConfig.settings,
              keybindings: serverConfig.keybindings,
            },
          ]
        : [],
    ),
  );

  return (
    <SettingsSection title="Actions">
      <SettingsRow
        title="Import scripts"
        aria-disabled
        description="Select a project to import actions from its checkout's t3.json."
        control={
          <Button size="xs" variant="ghost" disabled>
            Import scripts
          </Button>
        }
      />
      <SettingsRow
        title="Default actions"
        description="Available in every inheriting checkout. Commands run in that checkout or its worktree."
        resetAction={
          targets.some(
            (target) => (target.serverConfig?.settings.defaultProjectScripts.length ?? 0) > 0,
          ) ? (
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
          title="Different actions across machines"
          description="Select a machine to edit its actions. Adding an action applies to all selected connected machines."
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
