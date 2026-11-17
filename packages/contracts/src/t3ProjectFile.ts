import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { ProjectScriptIcon } from "./project.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

export const T3_PROJECT_FILE_NAME = "t3.json";

export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;

// Encoded-side annotations survive into JSON Schema; decoding still trims and rejects empty strings.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

const T3_PROJECT_FILE_MAX_WORKTREE_PATHS = 32;

const isWorktreeSeedablePath = (value: string) =>
  value.split("/").every((part) => {
    const lower = part.toLowerCase();
    return (
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      !/[\\\u0000-\u001f\u007f:]/.test(part) &&
      lower !== ".git" &&
      lower !== ".t3" &&
      !lower.startsWith(".env")
    );
  });

const worktreePath = (description: string) => {
  const decoded = Schema.String.check(
    Schema.isMaxLength(T3_PROJECT_FILE_PATH_MAX_LENGTH),
    Schema.makeFilter(isWorktreeSeedablePath, {
      message:
        "Expected a relative path with forward slashes, outside .git, .t3 and .env files, without . or .. segments",
    }),
  );
  return Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(
      decoded,
      SchemaTransformation.transform({
        decode: (value) => value.trim().replace(/\/+$/, ""),
        encode: (value) => value,
      }),
    ),
  );
};

const worktreePaths = (description: string, item: string) =>
  Schema.optionalKey(
    Schema.Array(worktreePath(item))
      .annotate({ description })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_WORKTREE_PATHS)),
  );

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Ada scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in an Ada terminal at the project root.",
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
        "When true, Ada stops this action's terminal and child processes when its thread settles.",
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
  description: "A project script that team members can import into Ada.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Ada\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in Ada overrides this; when neither is set, the global default applies.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in Ada overrides this.',
    }),
  ),
  worktreeSharedPaths: worktreePaths(
    'Git-ignored cache folders that every worktree of this repository shares (e.g. ".zig-cache"). Ada links each one to a single folder under its home, seeded from the source checkout when possible. Only list caches whose tool tolerates concurrent builds.',
    "Repository-relative folder shared by all worktrees.",
  ),
  worktreeClonePaths: worktreePaths(
    'Git-ignored folders copied from the source checkout into each new worktree before setup runs (e.g. "node_modules" or "target"). Ada uses copy-on-write clones, which take almost no space, and skips this where the filesystem cannot clone.',
    "Repository-relative folder cloned into new worktrees.",
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in Ada.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "Ada project file",
  description:
    "Checked-in project configuration for Ada (t3.json at the repository root). See https://github.com/jayleaton/ada for documentation.",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;

/** Keys must be nullable in ServerSettings so both environment and project overrides can inherit t3.json. */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // providerInstances overrides individual fields, so it cannot use whole-setting file inheritance.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof T3ProjectFile]: T3ProjectFile[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof T3ProjectFile];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
