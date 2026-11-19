import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { useRef, useState } from "react";

import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  hasMatchingProjectScript,
  nextProjectScriptId,
  saveProjectScriptToList,
} from "../../projectScripts";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NewProjectScriptInput } from "../projectScriptEditor";
import { m } from "../../i18n/messages";
import { toastManager } from "../ui/toast";

function reportScriptFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: m(msg("Failed to save project actions")),
      description:
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : m(msg("An error occurred.")),
    });
  }
  return mapAtomCommandResult(result, () => undefined);
}

export function useProjectScriptSettings(
  targets: readonly {
    environmentId: EnvironmentId;
    settings: ServerSettings;
    keybindings: ResolvedKeybindingsConfig;
    project?: { id: ProjectId; scripts: readonly ProjectScript[] };
  }[],
) {
  const projects = useProjects();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const readSettings = useAtomCommand(serverEnvironment.readSettings, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "project actions update");
  const upsertKeybinding = useAtomCommand(
    serverEnvironment.upsertKeybinding,
    "action shortcut update",
  );
  const removeKeybinding = useAtomCommand(
    serverEnvironment.removeKeybinding,
    "action shortcut removal",
  );

  async function withSave(
    write: () => Promise<AtomCommandResult<void, unknown>>,
  ): Promise<AtomCommandResult<void, unknown>> {
    if (savingRef.current || targets.length === 0) {
      const message = m(msg("No available machine, or another action change is saving."));
      toastManager.add({
        type: "error",
        title: m(msg("Actions not saved")),
        description: message,
      });
      return AsyncResult.failure(Cause.fail(new Error(message)));
    }
    if (
      targets.some(
        ({ environmentId }) => !readEnvironmentScope(environmentId, AuthSettingsWriteScope),
      )
    ) {
      return reportScriptFailure(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: m(msg("This connection cannot change environment settings.")),
            }),
          ),
        ),
      );
    }
    savingRef.current = true;
    setSaving(true);
    return write().finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  }

  function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId?: string,
    keybinding?: string | null,
  ) {
    return withSave(() => writeTargets(transform, scriptId, keybinding));
  }

  function writeScripts(
    environmentId: EnvironmentId,
    projectId: ProjectId | undefined,
    scripts: readonly ProjectScript[] | null,
  ) {
    return updateSettings({
      environmentId,
      input: {
        patch: projectId
          ? { projectScriptOverrides: { [projectId]: scripts } }
          : { defaultProjectScripts: scripts ?? [] },
      },
    });
  }

  async function writeTargets(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId: string | undefined,
    keybinding: string | null | undefined,
  ): Promise<AtomCommandResult<void, unknown>> {
    for (const { environmentId, settings, keybindings, project } of targets) {
      const current = project
        ? resolveProjectScripts(settings, project)
        : settings.defaultProjectScripts;
      const nextScripts = transform(current);
      const effectiveScripts = nextScripts ?? settings.defaultProjectScripts;
      const result = await writeScripts(environmentId, project?.id, nextScripts);
      if (result._tag === "Failure") return reportScriptFailure(result);
      const changedIds = scriptId
        ? [scriptId]
        : current
            .filter((script) => !effectiveScripts.some((next) => next.id === script.id))
            .map((script) => script.id);
      for (const id of changedIds) {
        if (keybinding === undefined && effectiveScripts.some((script) => script.id === id)) {
          continue;
        }
        const command = commandForProjectScript(id);
        const previousValue = keybindingValueForCommand(keybindings, command);
        const previous = previousValue
          ? decodeProjectScriptKeybindingRule({ keybinding: previousValue, command })
          : null;
        const next = decodeProjectScriptKeybindingRule({ keybinding, command });
        const retainedElsewhere =
          !nextScripts?.some((script) => script.id === id) &&
          ((project && settings.defaultProjectScripts.some((script) => script.id === id)) ||
            Object.entries(settings.projectSettingsOverrides).some(
              ([projectId, entry]) =>
                projectId !== project?.id &&
                entry.defaultProjectScripts?.some((script) => script.id === id),
            ) ||
            projects.some(
              (other) =>
                other.environmentId === environmentId &&
                other.id !== project?.id &&
                (project ? resolveProjectScripts(settings, other) : other.scripts).some(
                  (script) => script.id === id,
                ),
            ));
        const bindingResult = next
          ? await upsertKeybinding({
              environmentId,
              input: previous && previous.key !== next.key ? { ...next, replace: previous } : next,
            })
          : previous && !retainedElsewhere
            ? await removeKeybinding({ environmentId, input: previous })
            : null;
        if (bindingResult?._tag === "Failure") return reportScriptFailure(bindingResult);
      }
    }
    return AsyncResult.success(undefined);
  }

  function nextAvailableId(input: NewProjectScriptInput, currentTargets: typeof targets) {
    const existingIds = [
      ...projects.flatMap((project) => project.scripts.map((script) => script.id)),
      ...currentTargets.flatMap(({ settings, project }) =>
        [
          ...settings.defaultProjectScripts,
          ...Object.values(settings.projectSettingsOverrides).flatMap(
            (entry) => entry.defaultProjectScripts ?? [],
          ),
          ...(project?.scripts ?? []),
        ].map((script) => script.id),
      ),
    ];
    return nextProjectScriptId(input.name, existingIds);
  }

  async function writeImport(input: NewProjectScriptInput) {
    const settingsByEnvironment = new Map<EnvironmentId, ServerSettings>();
    const currentTargets: (typeof targets)[number][] = [];
    for (const target of targets) {
      let settings = settingsByEnvironment.get(target.environmentId);
      if (settings === undefined) {
        const result = await readSettings({ environmentId: target.environmentId, input: {} });
        if (result._tag === "Failure") return reportScriptFailure(result);
        settings = result.value;
        settingsByEnvironment.set(target.environmentId, settings);
      }
      currentTargets.push({ ...target, settings });
    }
    const id = nextAvailableId(input, currentTargets);
    for (const { environmentId, project, settings } of currentTargets) {
      const current = project
        ? resolveProjectScripts(settings, project)
        : settings.defaultProjectScripts;
      if (hasMatchingProjectScript(current, input)) continue;

      const scripts = saveProjectScriptToList(current, id, input, "add");
      const result = await writeScripts(environmentId, project?.id, scripts);
      if (result._tag === "Failure") return reportScriptFailure(result);
    }
    return AsyncResult.success(undefined);
  }

  function submit(scriptId: string | null, input: NewProjectScriptInput) {
    const id = scriptId ?? nextAvailableId(input, targets);
    return persist(
      (current) => saveProjectScriptToList(current, id, input, scriptId === null ? "add" : "edit"),
      id,
      input.keybinding,
    );
  }

  return {
    saving,
    persist,
    submit,
    importScript: (input: NewProjectScriptInput) => withSave(() => writeImport(input)),
  };
}
