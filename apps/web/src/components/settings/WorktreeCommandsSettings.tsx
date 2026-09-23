import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { buildProjectScript, nextProjectScriptId } from "../../projectScripts";
import { importableT3FileScripts, newScriptInputFromT3File } from "../projectScriptEditor";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const COMMAND_KINDS = [
  {
    kind: "create",
    searchId: "worktree-create-command",
    label: "worktree create command",
    description:
      "Runs instead of the built-in worktree creation, at the project root. It must check out $T3CODE_BRANCH at $T3CODE_WORKTREE_PATH, or print the path it used as its last line.",
  },
  {
    kind: "remove",
    searchId: "worktree-remove-command",
    label: "worktree remove command",
    description:
      "Runs instead of the built-in worktree removal, at the project root. It must delete $T3CODE_WORKTREE_PATH.",
  },
] as const;

/**
 * Custom worktree create/remove commands. A project's t3.json can suggest
 * them, but they only run once imported here, so opening a repository never
 * runs its commands on its own. Importing also brings the file's setup action,
 * which usually prepares the checkout those commands create.
 */
export function WorktreeCommandsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeCommands"]);
  const { scope, target } = useSettingsScope();

  const member =
    (scope.kind === "project" || scope.kind === "checkout") && target?.projectId
      ? scope.members.find((candidate) => candidate.id === target.projectId)
      : undefined;
  // The query is disabled without a checkout, so any id satisfies the hook.
  const t3File = useT3ProjectFileState(
    member?.environmentId ?? EnvironmentId.make("none"),
    member?.workspaceRoot ?? null,
  );
  const suggested = t3File.file?.worktreeCommands;
  const commands = settings.worktreeCommands;
  const scripts = settings.defaultProjectScripts;
  // Only one action runs on worktree creation, so only the file's first one is offered.
  const setupScript = importableT3FileScripts(scripts, t3File.scripts).find(
    (fileScript) => fileScript.runOnWorktreeCreate === true,
  );
  const importable =
    suggested !== undefined &&
    ((suggested.create ?? "") !== commands.create ||
      (suggested.remove ?? "") !== commands.remove ||
      setupScript !== undefined);

  // One write for both keys: each override write replaces the project's whole entry.
  const importFromFile = () => {
    if (suggested === undefined) return;
    const newScript = setupScript
      ? buildProjectScript(
          nextProjectScriptId(
            setupScript.name,
            scripts.map((script) => script.id),
          ),
          newScriptInputFromT3File(setupScript),
        )
      : null;
    updateSettings({
      worktreeCommands: { create: suggested.create ?? "", remove: suggested.remove ?? "" },
      ...(newScript
        ? {
            defaultProjectScripts: [
              ...scripts.map((script) => ({ ...script, runOnWorktreeCreate: false })),
              newScript,
            ],
          }
        : {}),
    });
  };

  return COMMAND_KINDS.map(({ kind, searchId, label, description }) => (
    <SettingsRow
      key={kind}
      serverScoped
      settingKeys={["worktreeCommands"]}
      {...searchableSetting(searchId)}
      description={description}
      resetAction={
        commands[kind] !== DEFAULT_UNIFIED_SETTINGS.worktreeCommands[kind] ? (
          <SettingResetButton
            label={label}
            onClick={() =>
              updateSettings({
                worktreeCommands: { [kind]: DEFAULT_UNIFIED_SETTINGS.worktreeCommands[kind] },
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-72">
          <DraftInput
            size="sm"
            className="w-full"
            value={mixed ? "" : commands[kind]}
            onCommit={(next) => updateSettings({ worktreeCommands: { [kind]: next } })}
            placeholder={mixed ? "Mixed" : "Built-in"}
            spellCheck={false}
            aria-label={label}
          />
          {kind === "create" && importable ? (
            <Button size="xs" variant="outline" className="self-end" onClick={importFromFile}>
              Use t3.json setup
            </Button>
          ) : null}
        </div>
      }
    />
  ));
}
