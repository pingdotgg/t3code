import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { EnvironmentId, type T3ProjectFileScript } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useT } from "../../hooks/useI18n";
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

export function ProjectActionsSettings() {
  const t = useT();
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
  const canWriteSettings = useScopedSettingsWriteAllowed();
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
          settings: environment.serverConfig.settings,
          keybindings: environment.serverConfig.keybindings,
          ...(member ? { project: member } : {}),
        },
      ];
    }),
  );

  const representativeMember = target?.projectId ? memberById.get(target.projectId) : undefined;
  const t3File = useT3ProjectFileState(
    representativeMember?.environmentId ?? EnvironmentId.make("none"),
    representativeMember?.workspaceRoot ?? null,
  );
  const importableScripts = t3File.scripts.filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  const importFileScript = async (fileScript: T3ProjectFileScript) => {
    const payload: NewProjectScriptInput = {
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      runOnSettle: fileScript.runOnSettle ?? false,
      stopOnSettle: fileScript.stopOnSettle ?? false,
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
        error:
          error instanceof Error ? error.message : t("settings.code.projectActions.importFailed"),
      });
    }
  };

  return (
    <SettingsSection id="project-actions" title={t("settings.code.projectActions.title")}>
      <SettingsRow
        serverScoped
        settingKeys={["defaultProjectScripts"]}
        mixed={mixed}
        title={t("settings.code.projectActions.title")}
        description={t("settings.code.projectActions.description")}
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
                      disabled={saving || !canWriteSettings}
                      type="button"
                    />
                  }
                >
                  {t("settings.code.projectActions.importScripts")}
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>
                      {t("settings.code.projectActions.importFromFile")}
                    </MenuGroupLabel>
                    <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                      {t("settings.code.projectActions.importHint")}
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
              disabled={saving || !canWriteSettings || targets.length === 0}
              onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
            >
              <PlusIcon className="size-3.5" />
              {t("settings.code.projectActions.addAction")}
            </Button>
          </div>
        }
      />
      {mixed ? (
        <SettingsRow
          title={t("settings.code.projectActions.mixedTitle")}
          description={t("settings.code.projectActions.mixedDescription")}
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={keybindings}
          disabled={saving || !canWriteSettings}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        />
      )}
      {t3File.status === "invalid" ? (
        <SettingsRow
          title={t("settings.code.projectActions.invalidTitle")}
          description={t("settings.code.projectActions.invalidDescription")}
          className="text-warning"
        />
      ) : null}
      {target && (
        <ProjectScriptEditorDialog
          environmentId={target.environmentId}
          editScope={AuthSettingsWriteScope}
          request={request}
          scripts={scripts}
          onSubmit={submit}
          onDelete={(id) =>
            void persist((current) => current.filter((script) => script.id !== id), id, null)
          }
          onClose={() => setRequest(null)}
        />
      )}
    </SettingsSection>
  );
}
