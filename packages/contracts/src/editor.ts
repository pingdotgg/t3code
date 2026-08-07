import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals([
  "direct-path",
  "goto",
  "line-column",
  "working-directory",
]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

/** Stands in for the resolved directory inside {@link EditorDefinition.cwdArgs}. */
export const EDITOR_CWD_PLACEHOLDER = "{cwd}";

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly macAppName?: string;
  /**
   * Integrations that open a directory rather than a file, and so need their
   * own launch path on the server.
   */
  readonly kind?: "file-manager" | "terminal";
  /**
   * Arguments a `working-directory` launch passes to the CLI, with
   * {@link EDITOR_CWD_PLACEHOLDER} standing in for the resolved directory.
   * Omitted means "pass the directory as the only argument".
   */
  readonly cwdArgs?: readonly [string, ...string[]];
};

export const EDITORS = [
  { id: "cursor", label: "Cursor", commands: ["cursor"], launchStyle: "goto" },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  { id: "vscode", label: "VS Code", commands: ["code"], launchStyle: "goto" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
  },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], launchStyle: "goto" },
  { id: "zed", label: "Zed", commands: ["zed", "zeditor"], launchStyle: "direct-path" },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], launchStyle: "goto" },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], launchStyle: "line-column" },
  { id: "clion", label: "CLion", commands: ["clion"], launchStyle: "line-column" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], launchStyle: "line-column" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], launchStyle: "line-column" },
  { id: "goland", label: "GoLand", commands: ["goland"], launchStyle: "line-column" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], launchStyle: "line-column" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], launchStyle: "line-column" },
  { id: "rider", label: "Rider", commands: ["rider"], launchStyle: "line-column" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], launchStyle: "line-column" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], launchStyle: "line-column" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], launchStyle: "line-column" },
  // Terminals open the project directory rather than a file. `macAppName` is
  // set only for the ones whose macOS bundle opens a folder argument in that
  // directory; the rest would silently start in the user's home, so they show
  // up only when their CLI is on PATH. They sit after the editors so a fresh
  // install with no stored preference still falls back to an editor.
  {
    id: "apple-terminal",
    label: "Terminal",
    commands: null,
    launchStyle: "working-directory",
    macAppName: "Terminal",
    kind: "terminal",
  },
  {
    id: "iterm2",
    label: "iTerm",
    commands: null,
    launchStyle: "working-directory",
    macAppName: "iTerm",
    kind: "terminal",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    commands: ["ghostty"],
    cwdArgs: ["--working-directory={cwd}"],
    launchStyle: "working-directory",
    macAppName: "Ghostty",
    kind: "terminal",
  },
  {
    id: "warp",
    label: "Warp",
    commands: null,
    launchStyle: "working-directory",
    macAppName: "Warp",
    kind: "terminal",
  },
  {
    id: "wezterm",
    label: "WezTerm",
    commands: ["wezterm"],
    cwdArgs: ["start", "--cwd", "{cwd}"],
    launchStyle: "working-directory",
    kind: "terminal",
  },
  {
    id: "kitty",
    label: "kitty",
    commands: ["kitty"],
    cwdArgs: ["--directory", "{cwd}"],
    launchStyle: "working-directory",
    kind: "terminal",
  },
  {
    id: "alacritty",
    label: "Alacritty",
    commands: ["alacritty"],
    cwdArgs: ["--working-directory", "{cwd}"],
    launchStyle: "working-directory",
    kind: "terminal",
  },
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    commands: ["wt"],
    cwdArgs: ["-d", "{cwd}"],
    launchStyle: "working-directory",
    kind: "terminal",
  },
  {
    id: "file-manager",
    label: "File Manager",
    commands: null,
    launchStyle: "direct-path",
    kind: "file-manager",
  },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

/**
 * Terminals are launch targets like the editors, but they are not an "open
 * this in an app" choice: they open a shell in the project, so the UI surfaces
 * them as their own action rather than as a row in the Open-in picker.
 */
export type TerminalId = Extract<(typeof EDITORS)[number], { kind: "terminal" }>["id"];

export const TERMINAL_IDS = EDITORS.filter(
  (editor): editor is Extract<(typeof EDITORS)[number], { kind: "terminal" }> =>
    "kind" in editor && editor.kind === "terminal",
).map((editor) => editor.id);

export const TerminalId = Schema.Literals(TERMINAL_IDS);

const TERMINAL_ID_SET: ReadonlySet<string> = new Set(TERMINAL_IDS);

export function isTerminalId(id: EditorId): id is TerminalId {
  return TERMINAL_ID_SET.has(id);
}

/** Label a terminal shows in the UI, or null when the id is not a terminal. */
export function terminalLabel(id: EditorId): string | null {
  return EDITORS.find((editor) => editor.id === id && isTerminalId(editor.id))?.label ?? null;
}

export const LaunchEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

export class ExternalLauncherUnknownEditorError extends Schema.TaggedErrorClass<ExternalLauncherUnknownEditorError>()(
  "ExternalLauncherUnknownEditorError",
  {
    editor: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown editor: ${this.editor}`;
  }
}

export class ExternalLauncherUnsupportedEditorError extends Schema.TaggedErrorClass<ExternalLauncherUnsupportedEditorError>()(
  "ExternalLauncherUnsupportedEditorError",
  {
    editor: EditorId,
  },
) {
  override get message(): string {
    return `Unsupported editor: ${this.editor}`;
  }
}

export class ExternalLauncherCommandNotFoundError extends Schema.TaggedErrorClass<ExternalLauncherCommandNotFoundError>()(
  "ExternalLauncherCommandNotFoundError",
  {
    editor: EditorId,
    command: Schema.String,
  },
) {
  override get message(): string {
    return `Editor command not found: ${this.command}`;
  }
}

const ExternalLauncherSpawnFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
};

export class ExternalLauncherBrowserSpawnError extends Schema.TaggedErrorClass<ExternalLauncherBrowserSpawnError>()(
  "ExternalLauncherBrowserSpawnError",
  {
    ...ExternalLauncherSpawnFields,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to launch browser target '${this.target}' with '${[this.command, ...this.args].join(" ")}'`;
  }
}

export class ExternalLauncherEditorSpawnError extends Schema.TaggedErrorClass<ExternalLauncherEditorSpawnError>()(
  "ExternalLauncherEditorSpawnError",
  {
    ...ExternalLauncherSpawnFields,
    editor: EditorId,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to launch '${this.target}' in ${this.editor} with '${[this.command, ...this.args].join(" ")}'`;
  }
}

export const ExternalLauncherError = Schema.Union([
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherEditorSpawnError,
]);
export type ExternalLauncherError = typeof ExternalLauncherError.Type;

export const isExternalLauncherError = Schema.is(ExternalLauncherError);
