import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { ProjectScriptIcon } from "./project.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

export const LATHE_PROJECT_FILE_NAME = "lathe.json";

export const LATHE_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const LATHE_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const LATHE_PROJECT_FILE_MAX_SCRIPTS = 50;

// Encoded-side annotations survive into JSON Schema; decoding still trims and rejects empty strings.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const LatheProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Lathe scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a Lathe terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs in the thread's worktree each time the thread settles, for example to delete build output. Threads without their own worktree skip it.",
    }),
  ),
  stopOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, Lathe stops this action's terminal and child processes when its thread settles.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into Lathe.",
});
export type LatheProjectFileScript = typeof LatheProjectFileScript.Type;

export const LatheProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${LATHE_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Lathe\'s built-in icon locations.',
      },
      LATHE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in Lathe overrides this; when neither is set, the global default applies.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in Lathe overrides this.',
    }),
  ),
  worktreeSparsePatternsPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Repository-relative path to a git sparse-checkout pattern file in non-cone syntax (e.g. ".lathe/sparse-checkout"). New worktrees check out only the files it matches. Both files are read from the branch being checked out; a missing pattern file fails the worktree instead of checking out everything.',
      },
      LATHE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(LatheProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in Lathe.",
      })
      .check(Schema.isMaxLength(LATHE_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "Lathe project file",
  description:
    "Checked-in project configuration for Lathe (lathe.json at the repository root). See https://t3.codes for documentation.",
});
export type LatheProjectFile = typeof LatheProjectFile.Type;

/** Keys must be nullable in ServerSettings so both environment and project overrides can inherit lathe.json. */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // providerInstances overrides individual fields, so it cannot use whole-setting file inheritance.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof LatheProjectFile]: LatheProjectFile[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof LatheProjectFile];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
