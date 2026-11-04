import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals([
  "direct-path",
  "goto",
  "line-column",
  "neovim",
  "terminal",
]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly remoteScheme?: string;
  readonly jetbrainsProductCode?: string;
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    // File and workspace opens must target the IDE even when the Agents Window is active.
    baseArgs: ["--classic"],
    launchStyle: "goto",
    remoteScheme: "cursor",
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    remoteScheme: "vscode",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    remoteScheme: "vscode-insiders",
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    launchStyle: "goto",
    remoteScheme: "vscodium",
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    remoteScheme: "zed",
  },
  { id: "neovide", label: "Neovide", commands: ["neovide"], launchStyle: "neovim" },
  {
    id: "antigravity",
    label: "Antigravity",
    // The IDE ships antigravity-ide; agy is the standalone CLI.
    commands: ["antigravity-ide", "agy-ide"],
    launchStyle: "goto",
  },
  {
    id: "idea",
    label: "IntelliJ IDEA",
    commands: ["idea"],
    launchStyle: "line-column",
    jetbrainsProductCode: "IU",
  },
  {
    id: "aqua",
    label: "Aqua",
    commands: ["aqua"],
    launchStyle: "line-column",
    jetbrainsProductCode: "QA",
  },
  {
    id: "clion",
    label: "CLion",
    commands: ["clion"],
    launchStyle: "line-column",
    jetbrainsProductCode: "CL",
  },
  {
    id: "datagrip",
    label: "DataGrip",
    commands: ["datagrip"],
    launchStyle: "line-column",
    jetbrainsProductCode: "DB",
  },
  {
    id: "dataspell",
    label: "DataSpell",
    commands: ["dataspell"],
    launchStyle: "line-column",
    jetbrainsProductCode: "DS",
  },
  {
    id: "goland",
    label: "GoLand",
    commands: ["goland"],
    launchStyle: "line-column",
    jetbrainsProductCode: "GO",
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    commands: ["phpstorm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "PS",
  },
  {
    id: "pycharm",
    label: "PyCharm",
    commands: ["pycharm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "PY",
  },
  {
    id: "rider",
    label: "Rider",
    commands: ["rider"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RD",
  },
  {
    id: "rubymine",
    label: "RubyMine",
    commands: ["rubymine"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RM",
  },
  {
    id: "rustrover",
    label: "RustRover",
    commands: ["rustrover"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RR",
  },
  {
    id: "webstorm",
    label: "WebStorm",
    commands: ["webstorm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "WS",
  },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
  // Last so it only becomes the default editor when nothing the server can launch exists.
  { id: "neovim", label: "Neovim", commands: ["nvim"], launchStyle: "terminal" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const isTerminalEditor = (id: EditorId): boolean =>
  EDITORS.some((editor) => editor.id === id && editor.launchStyle === "terminal");

export const EDITOR_TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
// A PTY acts on these before the shell parses the line, so quoting cannot contain them.
const TERMINAL_UNSAFE_TARGET_PATTERN = /[\u0000-\u001f\u007f]/;

const quotePosixArgument = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A POSIX shell line; servers do not offer terminal editors on Windows. */
export const buildTerminalEditorCommand = (id: EditorId, target: string): string | undefined => {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  if (editor?.launchStyle !== "terminal" || TERMINAL_UNSAFE_TARGET_PATTERN.test(target)) {
    return undefined;
  }
  const match = EDITOR_TARGET_WITH_POSITION_PATTERN.exec(target);
  const path = match?.[1] || target;
  const position = match?.[2] ? [`'+call cursor(${match[2]},${match[3] ?? "1"})'`] : [];
  return [editor.commands[0], ...position, "--", quotePosixArgument(path)].join(" ");
};

export const FileManagerRevealKind = Schema.Literals(["finder", "file-explorer", "files"]);
export type FileManagerRevealKind = typeof FileManagerRevealKind.Type;

export const LaunchEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
  /** Only for file-manager; requires the server's shellRevealInFileManager capability. */
  reveal: Schema.optional(Schema.Boolean),
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

const remoteSchemeOf = (editor: EditorDefinition): string | undefined =>
  editor.remoteScheme ?? (editor.jetbrainsProductCode === undefined ? undefined : "jetbrains");

export const REMOTE_CAPABLE_EDITOR_IDS: ReadonlyArray<EditorId> = EDITORS.flatMap((editor) =>
  remoteSchemeOf(editor) !== undefined ? [editor.id] : [],
);

export const remoteSchemeForEditor = (id: EditorId): string | undefined => {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  return editor === undefined ? undefined : remoteSchemeOf(editor);
};

export const buildRemoteOpenUrl = (input: {
  readonly editor: EditorId;
  readonly host: string;
  readonly username?: string;
  readonly absolutePath: string;
  readonly isFile?: boolean;
}): string | undefined => {
  const scheme = remoteSchemeForEditor(input.editor);
  if (scheme === undefined) {
    return undefined;
  }
  const editor = EDITORS.find((candidate) => candidate.id === input.editor);
  if (editor !== undefined && "jetbrainsProductCode" in editor) {
    const params = new URLSearchParams({
      h: input.host,
      launchIde: "true",
      ideHint: editor.jetbrainsProductCode,
      projectHint: input.absolutePath.replaceAll("\\", "/"),
    });
    if (input.username !== undefined) {
      params.set("u", input.username);
    }
    return `${scheme}://gateway/ssh/environment?${params.toString()}`;
  }
  // Windows server paths (`C:\...`) appear as `/C:/...` in vscode-remote URIs.
  const posixPath = input.absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encodedHost = encodeURIComponent(input.host);
  if (input.editor === "zed") {
    // Zed roots paths on the system drive, so omit the Windows drive prefix.
    const zedPath = /^[Cc]:[\\/]/.test(input.absolutePath) ? rootedPath.slice(3) : rootedPath;
    const encodedZedPath = zedPath.split("/").map(encodeURIComponent).join("/");
    // Zed reads this segment as ssh URL userinfo, so the `@` stays literal.
    const zedDestination =
      input.username === undefined
        ? encodedHost
        : `${encodeURIComponent(input.username)}@${encodedHost}`;
    return `${scheme}://ssh/${zedDestination}${encodedZedPath}`;
  }
  const encodedPath = rootedPath.split("/").map(encodeURIComponent).join("/");
  const destination = input.username === undefined ? input.host : `${input.username}@${input.host}`;
  // VS Code opens a bare vscode-remote path as a folder; a trailing position makes it open the file.
  return `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${encodedPath}${input.isFile ? ":1:1" : ""}`;
};

export const RemoteOpenTargetKind = Schema.Literals(["tailscale", "mdns"]);
export type RemoteOpenTargetKind = typeof RemoteOpenTargetKind.Type;

export const RemoteOpenTarget = Schema.Struct({
  kind: RemoteOpenTargetKind,
  host: TrimmedNonEmptyString,
  username: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RemoteOpenTarget = typeof RemoteOpenTarget.Type;

export class ExternalLauncherUnknownEditorError extends Schema.TaggedError<ExternalLauncherUnknownEditorError>()(
  "ExternalLauncherUnknownEditorError",
  {
    editor: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown editor: ${this.editor}`;
  }
}

export class ExternalLauncherUnsupportedEditorError extends Schema.TaggedError<ExternalLauncherUnsupportedEditorError>()(
  "ExternalLauncherUnsupportedEditorError",
  {
    editor: EditorId,
  },
) {
  override get message(): string {
    return `Unsupported editor: ${this.editor}`;
  }
}

export class ExternalLauncherCommandNotFoundError extends Schema.TaggedError<ExternalLauncherCommandNotFoundError>()(
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

export class ExternalLauncherUnsupportedTargetError extends Schema.TaggedError<ExternalLauncherUnsupportedTargetError>()(
  "ExternalLauncherUnsupportedTargetError",
  {
    editor: EditorId,
  },
) {
  override get message(): string {
    return `${this.editor} cannot open a path containing line breaks or double quotes`;
  }
}

const ExternalLauncherSpawnFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
};

export class ExternalLauncherBrowserSpawnError extends Schema.TaggedError<ExternalLauncherBrowserSpawnError>()(
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

export class ExternalLauncherEditorSpawnError extends Schema.TaggedError<ExternalLauncherEditorSpawnError>()(
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
  ExternalLauncherUnsupportedTargetError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherEditorSpawnError,
]);
export type ExternalLauncherError = typeof ExternalLauncherError.Type;
