/**
 * ProjectSettingsService - a project's model, thread env mode, auto-pull and
 * scripts, kept where new threads read them.
 *
 * Launch and the new-thread UI resolve these from the environment's
 * `projectSettingsOverrides`, and once project settings are folded they never
 * read the project record. Writes therefore go to the override entry, while
 * title, icon, favicon and workspace root stay on the record through
 * `ProjectService`. Reads return the resolved values, the ones launch uses.
 *
 * @module ProjectSettingsService
 */
import {
  type Project,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProjectUpdatePayload,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Settings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

type SettingsFields = Pick<
  ProjectUpdatePayload,
  "defaultModelSelection" | "defaultThreadEnvMode" | "autoPull" | "scripts"
>;

export class ProjectSettingsService extends Context.Service<
  ProjectSettingsService,
  {
    /** Registers the project, then saves its scripts and model as its settings. */
    readonly create: (
      input: ProjectService.ProjectCreateInput,
    ) => Effect.Effect<Project, ProjectService.ProjectServiceError | ServerSettingsError>;
    /**
     * Updates the record, then saves the settings fields. `null`, and an empty
     * script list, clear the project's value so the environment default applies.
     */
    readonly update: (
      input: ProjectService.ProjectUpdateInput,
    ) => Effect.Effect<Project, ProjectService.ProjectServiceError | ServerSettingsError>;
    readonly getById: (
      projectId: ProjectId,
    ) => Effect.Effect<
      Option.Option<Project>,
      ProjectService.ProjectOperationError | ServerSettingsError
    >;
    /** Projects that are not deleted, in snapshot order. */
    readonly listActive: Effect.Effect<
      ReadonlyArray<Project>,
      ProjectService.ProjectOperationError | ServerSettingsError
    >;
  }
>()("t3/project/ProjectSettingsService") {}

/** The project with the model, env mode, auto-pull and scripts its new threads get. */
function resolved(settings: ServerSettings, project: Project): Project {
  const effective = resolveProjectSettings(settings, project.id, project).settings;
  return {
    ...project,
    defaultModelSelection: effective.defaultModelSelection,
    defaultThreadEnvMode: effective.defaultThreadEnvMode,
    autoPull: effective.defaultAutoPull,
    scripts: resolveProjectScripts(settings, project),
  };
}

/**
 * The project's override entry with `fields` applied, `undefined` when none is
 * set. A stored null model would mean "no default model", so `null` removes the
 * key instead; an empty script list on the record always meant "use the
 * environment's actions", so it removes the key too.
 */
function nextOverrides(
  current: ProjectSettingsOverrides | undefined,
  { defaultModelSelection, defaultThreadEnvMode, autoPull, scripts }: SettingsFields,
): ProjectSettingsOverrides | undefined {
  if (
    defaultModelSelection === undefined &&
    defaultThreadEnvMode === undefined &&
    autoPull === undefined &&
    scripts === undefined
  )
    return undefined;
  const entry: ProjectSettingsOverrides = { ...current };
  const set = <K extends keyof ProjectSettingsOverrides>(
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) delete entry[key];
    else entry[key] = value;
  };
  if (defaultModelSelection !== undefined)
    set("defaultModelSelection", defaultModelSelection ?? undefined);
  if (defaultThreadEnvMode !== undefined)
    set("defaultThreadEnvMode", defaultThreadEnvMode ?? undefined);
  if (autoPull !== undefined) set("defaultAutoPull", autoPull);
  if (scripts !== undefined)
    set("defaultProjectScripts", scripts.length === 0 ? undefined : scripts);
  return entry;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* Settings.ServerSettingsService;

  /** Saves the fields a caller set and returns the settings afterwards. */
  const save = Effect.fn("ProjectSettingsService.save")(function* (
    projectId: ProjectId,
    fields: SettingsFields,
  ) {
    const current = yield* serverSettings.getSettings;
    const entry = nextOverrides(current.projectSettingsOverrides[projectId], fields);
    if (entry === undefined) return current;
    // The patch replaces the project's whole entry, so it starts from the stored one.
    return yield* serverSettings.updateSettings({
      projectSettingsOverrides: { [projectId]: Object.keys(entry).length === 0 ? null : entry },
    });
  });

  const create: ProjectSettingsService["Service"]["create"] = Effect.fn(
    "ProjectSettingsService.create",
  )(function* ({ scripts, defaultModelSelection, ...input }) {
    const project = yield* projects.create(input);
    return resolved(yield* save(project.id, { scripts, defaultModelSelection }), project);
  });

  const update: ProjectSettingsService["Service"]["update"] = Effect.fn(
    "ProjectSettingsService.update",
  )(function* ({ defaultModelSelection, defaultThreadEnvMode, autoPull, scripts, ...input }) {
    // The record update runs first: it rejects an unknown project before any
    // override is stored for it. A clear also reaches the record, whose own
    // copy still backs a cleared override until settings are folded.
    const project = yield* projects.update({
      ...input,
      ...(defaultModelSelection === null ? { defaultModelSelection } : {}),
      ...(defaultThreadEnvMode === null ? { defaultThreadEnvMode } : {}),
      ...(scripts?.length === 0 ? { scripts } : {}),
    });
    const settings = yield* save(project.id, {
      defaultModelSelection,
      defaultThreadEnvMode,
      autoPull,
      scripts,
    });
    return resolved(settings, project);
  });

  const getById: ProjectSettingsService["Service"]["getById"] = Effect.fn(
    "ProjectSettingsService.getById",
  )(function* (projectId) {
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) return project;
    return Option.some(resolved(yield* serverSettings.getSettings, project.value));
  });

  const listActive: ProjectSettingsService["Service"]["listActive"] = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot;
    const settings = yield* serverSettings.getSettings;
    return snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => resolved(settings, project));
  });

  return ProjectSettingsService.of({ create, update, getById, listActive });
});

export const layer = Layer.effect(ProjectSettingsService, make);
