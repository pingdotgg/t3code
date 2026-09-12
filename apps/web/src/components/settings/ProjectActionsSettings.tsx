import { EnvironmentId, type T3ProjectFileScript } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * A project's actions on each selected environment. Actions belong to a
 * project, so this only renders at a project scope; the environment's
 * `defaultProjectScripts` is the layer a project without its own list
 * inherits. Shortcuts are environment-wide, so the same action id shares its
 * binding on an environment.
 */
export function ProjectActionsSettings() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
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
      // An older server ignores the override record, so a project edit there
      // would report success and vanish; such environments are left out and
      // the legacy per-project map keeps serving them.
      if (
        member &&
        environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
      ) {
        return [];
      }
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

  // A project's t3.json can declare actions to import. Read it from the
  // representative checkout; the imported action still fans out.
  const representativeMember = target?.projectId ? memberById.get(target.projectId) : undefined;
  const t3File = useT3ProjectFileState(
    representativeMember?.environmentId ?? EnvironmentId.make("none"),
    representativeMember?.workspaceRoot ?? null,
  );
  const importableScripts = useMemo(
    () =>
      t3File.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, t3File.scripts],
  );
  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submit(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submit],
  );

  return (
    <SettingsSection id="project-actions" title="Actions">
      <SettingsRow
        serverScoped
        settingKeys={["defaultProjectScripts"]}
        mixed={mixed}
        title="Actions"
        description={`Commands that run in this project's ${DEFAULT_VCS_TERMINOLOGY.currentRefFallback} or its ${DEFAULT_VCS_TERMINOLOGY.workspaceNoun}, with optional shortcuts.`}
        onResetOverride={() => void persist(() => null)}
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {importableScripts.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      id="import-scripts"
                      size="xs"
                      variant="ghost"
                      disabled={saving}
                      type="button"
                    />
                  }
                >
                  Import scripts
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-72">
                  <MenuGroup>
                    <MenuGroupLabel>Import from t3.json</MenuGroupLabel>
                    <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                      Add actions declared by this checkout without editing them first.
                    </p>
                  </MenuGroup>
                  <MenuSeparator />
                  {importableScripts.map((fileScript) => (
                    <MenuItem
                      key={`${fileScript.name} ${fileScript.command}`}
                      onClick={() => void importFileScript(fileScript)}
                    >
                      <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{fileScript.name}</div>
                        <div className="truncate font-mono text-muted-foreground">
                          {fileScript.command}
                        </div>
                      </div>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={saving || targets.length === 0}
              onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={keybindings}
          disabled={saving}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        />
      )}
      {t3File.status === "invalid" ? (
        <SettingsRow
          title="t3.json is invalid"
          description="A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
          className="text-warning"
        />
      ) : null}
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
