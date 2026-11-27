import { msg } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import type {
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  EnvironmentId,
  ServerSettings,
} from "@t3tools/contracts";
import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  createAtomCommandScheduler,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  hasMatchingProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  saveProjectScriptToList,
} from "../../projectScripts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentKeybindings, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { readProject, readProjects } from "../../state/entities";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

const projectScriptEdits = createAtomCommandScheduler();

/** Write script settings before reconciling shortcuts in environment keybindings. */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId } | null;
}) {
  const { environmentId, project } = input;
  const readSettings = useAtomCommand(serverEnvironment.readSettings, { reportFailure: false });
  const readKeybindings = useAtomCommand(readEnvironmentKeybindings, { reportFailure: false });
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const persistProjectScripts = async (input: {
    projectId: ProjectId;
    settings: ServerSettings;
    previousScripts: ReadonlyArray<ProjectScript>;
    nextScripts: ReadonlyArray<ProjectScript>;
    keybinding: NewProjectScriptInput["keybinding"];
    keybindingCommand: KeybindingCommand | null;
  }): Promise<AtomCommandResult<void, unknown>> => {
    const { settings } = input;
    const scriptId = input.keybindingCommand
      ? projectScriptIdFromCommand(input.keybindingCommand)
      : null;
    const isDeletingScript = !input.nextScripts.some((script) => script.id === scriptId);
    const requestedKeybinding = input.keybinding?.trim() || null;
    const shouldReadKeybindings =
      input.keybinding !== undefined &&
      input.keybindingCommand !== null &&
      (!isDeletingScript || readEnvironmentScope(environmentId, AuthSettingsWriteScope)) &&
      (requestedKeybinding !== null ||
        input.previousScripts.some((script) => script.id === scriptId));
    // The config stream can lag an acknowledged shortcut update too.
    const keybindingsResult = shouldReadKeybindings
      ? await readKeybindings({ environmentId, input: {} })
      : null;
    if (keybindingsResult?._tag === "Failure")
      return mapAtomCommandResult(keybindingsResult, () => undefined);
    const keybindings = keybindingsResult?.value.keybindings ?? [];
    const changesKeybinding =
      shouldReadKeybindings &&
      requestedKeybinding !== keybindingValueForCommand(keybindings, input.keybindingCommand);
    if (changesKeybinding && !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: m(msg("This connection cannot change keyboard shortcuts.")),
          }),
        ),
      );
    }
    const keybindingRule = changesKeybinding
      ? decodeProjectScriptKeybindingRule({
          keybinding: input.keybinding,
          command: input.keybindingCommand,
        })
      : null;
    const updateResult = mapAtomCommandResult(
      await updateProjectScriptSettings({
        environmentId,
        input: {
          patch: {
            projectScriptOverrides: { [input.projectId]: input.nextScripts },
          },
        },
      }),
      () => undefined,
    );
    if (updateResult._tag === "Failure") {
      return updateResult;
    }

    if (!changesKeybinding) return updateResult;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: isDeletingScript
              ? m(
                  msg(
                    "The script was deleted, but its keyboard shortcut could not be removed because permission changed.",
                  ),
                )
              : m(
                  msg(
                    "The script was saved, but this connection can no longer change keyboard shortcuts.",
                  ),
                ),
          }),
        ),
      );
    }

    const retainedElsewhere =
      isDeletingScript &&
      (settings.defaultProjectScripts.some((script) => script.id === scriptId) ||
        Object.entries(settings.projectSettingsOverrides).some(
          ([projectId, entry]) =>
            projectId !== input.projectId &&
            entry.defaultProjectScripts?.some((script) => script.id === scriptId),
        ) ||
        readProjects().some(
          (other) =>
            other.environmentId === environmentId &&
            other.id !== input.projectId &&
            resolveProjectScripts(settings, other).some((script) => script.id === scriptId),
        ));
    if (!keybindingRule && retainedElsewhere) return updateResult;

    const previousRules = keybindings.flatMap((binding) => {
      if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
      const previous = decodeProjectScriptKeybindingRule({
        keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
        command: input.keybindingCommand,
      });
      return previous ? [previous] : [];
    });
    const previous = previousRules.at(-1);
    for (const rule of keybindingRule ? previousRules.slice(0, -1) : previousRules) {
      const result = await removeKeybinding({ environmentId, input: rule });
      if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
    }
    return keybindingRule
      ? mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input:
              previous && previous.key !== keybindingRule.key
                ? { ...keybindingRule, replace: previous }
                : keybindingRule,
          }),
          () => undefined,
        )
      : updateResult;
  };
  const editProjectScripts = async (
    edit: (
      projectId: ProjectId,
      settings: ServerSettings,
      scripts: readonly ProjectScript[],
    ) => Promise<AtomCommandResult<void, unknown>>,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const ref = scopeProjectRef(environmentId, project.id);
    return Effect.runPromise(
      projectScriptEdits.schedule(
        appAtomRegistry,
        { mode: "serial", key: scopedProjectKey },
        ref,
        Effect.promise(async () => {
          // The config stream can still be behind the previous edit's acknowledged write.
          const result = await readSettings({ environmentId, input: {} });
          if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
          const currentProject = readProject(ref);
          if (!currentProject) {
            return AsyncResult.failure(
              Cause.fail(new Error(m(msg("This project is no longer available.")))),
            );
          }
          return edit(
            ref.projectId,
            result.value,
            resolveProjectScripts(result.value, currentProject),
          );
        }),
      ),
    );
  };

  const submitProjectScript = (
    scriptId: string | null,
    input: NewProjectScriptInput,
    source: "editor" | "import" = "editor",
  ) =>
    editProjectScripts(async (projectId, settings, scripts) => {
      if (source === "import" && hasMatchingProjectScript(scripts, input)) {
        return AsyncResult.success(undefined);
      }
      if (scriptId !== null && !scripts.some((script) => script.id === scriptId)) {
        return AsyncResult.failure(Cause.fail(new Error(m(msg("Script not found.")))));
      }
      const id =
        scriptId ??
        nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
      return persistProjectScripts({
        projectId,
        settings,
        previousScripts: scripts,
        nextScripts: saveProjectScriptToList(
          scripts,
          id,
          input,
          scriptId === null ? "add" : "edit",
        ),
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(id),
      });
    });

  const deleteProjectScript = async (
    scriptId: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    let deletedName: string | undefined;
    const result = await editProjectScripts((projectId, settings, scripts) => {
      deletedName = scripts.find((script) => script.id === scriptId)?.name;
      return persistProjectScripts({
        projectId,
        settings,
        previousScripts: scripts,
        nextScripts: scripts.filter((script) => script.id !== scriptId),
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: m(
          msg('Deleted action "{name}"', {
            name:
              deletedName ?? m(msg("Unknown", { $context: "fallback name of a deleted action" })),
          }),
        ),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not delete action")),
          description: thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
        }),
      );
    }
    return result;
  };
  return {
    saveProjectScript: useStableCallback((input: NewProjectScriptInput) =>
      submitProjectScript(null, input),
    ),
    importProjectScript: useStableCallback((input: NewProjectScriptInput) =>
      submitProjectScript(null, input, "import"),
    ),
    updateProjectScript: useStableCallback((scriptId: string, input: NewProjectScriptInput) =>
      submitProjectScript(scriptId, input),
    ),
    deleteProjectScript: useStableCallback(deleteProjectScript),
  };
}
