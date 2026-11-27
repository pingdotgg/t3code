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
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  projectActionSettingsSnapshot,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { useRef, useState } from "react";

import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  releaseClaimedRoles,
} from "../../projectScripts";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NewProjectScriptInput, ProjectScriptCreation } from "../projectScriptEditor";
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

interface ProjectScriptSettingsTarget {
  environmentId: EnvironmentId;
  settings: ServerSettings;
  keybindings: ResolvedKeybindingsConfig;
  project?: { id: ProjectId; scripts: readonly ProjectScript[] };
}

function targetKey(environmentId: EnvironmentId, projectId?: ProjectId): string {
  return JSON.stringify([environmentId, projectId]);
}

function targetScripts({ settings, project }: ProjectScriptSettingsTarget) {
  return project ? resolveProjectScripts(settings, project) : settings.defaultProjectScripts;
}

interface SettingsCreation {
  id: string;
  acknowledgedTargets: Set<string>;
  onActionCreated?: (creation: ProjectScriptCreation) => void;
}

export function useProjectScriptSettings(targets: readonly ProjectScriptSettingsTarget[]) {
  const projects = useProjects();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "project actions update");
  const upsertKeybinding = useAtomCommand(
    serverEnvironment.upsertKeybinding,
    "action shortcut update",
  );
  const removeKeybinding = useAtomCommand(
    serverEnvironment.removeKeybinding,
    "action shortcut removal",
  );

  async function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId?: string,
    keybinding?: string | null,
    creation?: SettingsCreation,
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
    return writeTargets(transform, scriptId, keybinding, creation).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  }

  async function writeTargets(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId: string | undefined,
    keybinding: string | null | undefined,
    creation: SettingsCreation | undefined,
  ): Promise<AtomCommandResult<void, unknown>> {
    if (
      creation &&
      targets.some((target) => {
        const { environmentId, settings } = target;
        const claims = projectActionSettingsSnapshot(settings);
        const claimed = (scripts: readonly ProjectScript[]) =>
          scripts.some((script) => script.id === creation.id);
        const claimedOutsideCreation = (projectId: ProjectId, scripts: readonly ProjectScript[]) =>
          !creation.acknowledgedTargets.has(targetKey(environmentId, projectId)) &&
          claimed(scripts);
        if (
          (!creation.acknowledgedTargets.has(targetKey(environmentId)) &&
            claimed(claims.defaultProjectScripts)) ||
          Object.entries(claims.projectActionsById).some(([projectId, scripts]) =>
            claimedOutsideCreation(ProjectId.make(projectId), scripts),
          )
        )
          return true;
        if (claims.projectSettingsFolded) return false;
        if (
          Object.entries(claims.projectScriptOverrides).some(
            ([projectId, scripts]) =>
              scripts !== null &&
              claims.projectActionsById[ProjectId.make(projectId)] === undefined &&
              claimedOutsideCreation(ProjectId.make(projectId), scripts),
          )
        )
          return true;

        const environmentProjects = [
          ...projects.filter((project) => project.environmentId === environmentId),
          ...targets.flatMap((target) =>
            target.environmentId === environmentId && target.project ? [target.project] : [],
          ),
        ];
        return environmentProjects.some(
          ({ id, scripts }) =>
            claims.projectActionsById[id] === undefined &&
            claims.projectScriptOverrides[id] === undefined &&
            claimedOutsideCreation(id, scripts),
        );
      })
    ) {
      return reportScriptFailure(
        AsyncResult.failure(
          Cause.fail(
            new Error(m(msg("Another action on a selected machine already uses this ID."))),
          ),
        ),
      );
    }

    const savedSettings = new Map<EnvironmentId, ServerSettings>();
    for (const target of targets) {
      const { environmentId, keybindings, project } = target;
      const settings = savedSettings.get(environmentId) ?? target.settings;
      const current = targetScripts({ ...target, settings });
      const nextScripts = transform(current);
      const effectiveScripts = nextScripts ?? settings.defaultProjectScripts;
      const result = await updateSettings({
        environmentId,
        input: {
          ...(creation ? { expectedProjectActions: projectActionSettingsSnapshot(settings) } : {}),
          patch: project
            ? {
                projectSettingsOverrides: {
                  [project.id]:
                    nextScripts === null
                      ? clearProjectSettingsOverrides(settings, project.id, [
                          "defaultProjectScripts",
                        ])
                      : {
                          ...settings.projectSettingsOverrides[project.id],
                          defaultProjectScripts: nextScripts,
                        },
                },
              }
            : { defaultProjectScripts: nextScripts ?? [] },
        },
      });
      if (result._tag === "Failure") return reportScriptFailure(result);
      if (creation) {
        savedSettings.set(environmentId, result.value);
        creation.acknowledgedTargets.add(targetKey(environmentId, project?.id));
        creation.onActionCreated?.({
          id: creation.id,
          acknowledgedTargets: new Set(creation.acknowledgedTargets),
        });
      }
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

  function submit(
    scriptId: string | null,
    input: NewProjectScriptInput,
    onActionCreated?: (creation: ProjectScriptCreation) => void,
    previousCreation?: ProjectScriptCreation,
  ) {
    const existingIds = [
      ...projects.flatMap((project) => project.scripts.map((script) => script.id)),
      ...targets.flatMap(({ settings, project }) =>
        [
          ...settings.defaultProjectScripts,
          ...Object.values(settings.projectSettingsOverrides).flatMap(
            (entry) => entry.defaultProjectScripts ?? [],
          ),
          ...(project?.scripts ?? []),
        ].map((script) => script.id),
      ),
    ];
    const id = scriptId ?? nextProjectScriptId(input.name, existingIds);
    const next = buildProjectScript(id, input);
    const creating = scriptId === null || previousCreation !== undefined;
    return persist(
      (current) => {
        const updated = current.map((script) =>
          script.id === id ? next : releaseClaimedRoles(script, input),
        );
        return creating && !current.some((script) => script.id === id)
          ? [...updated, next]
          : updated;
      },
      id,
      input.keybinding,
      creating
        ? {
            id,
            acknowledgedTargets: new Set(previousCreation?.acknowledgedTargets),
            ...(onActionCreated ? { onActionCreated } : {}),
          }
        : undefined,
    );
  }

  return { saving, persist, submit };
}
