import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly remoteOpen?: RemoteEditorOpenDefinition;
};

export type RemoteEditorOpenDefinition = {
  readonly scheme: string;
  readonly urlHost: string;
  readonly sshPathPrefix: string;
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    launchStyle: "goto",
    remoteOpen: { scheme: "cursor", urlHost: "vscode-remote", sshPathPrefix: "ssh-remote+" },
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    remoteOpen: { scheme: "vscode", urlHost: "vscode-remote", sshPathPrefix: "ssh-remote+" },
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    remoteOpen: {
      scheme: "vscode-insiders",
      urlHost: "vscode-remote",
      sshPathPrefix: "ssh-remote+",
    },
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    launchStyle: "goto",
    remoteOpen: { scheme: "vscodium", urlHost: "vscode-remote", sshPathPrefix: "ssh-remote+" },
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    remoteOpen: { scheme: "zed", urlHost: "ssh", sshPathPrefix: "" },
  },
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
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const FileManagerRevealKind = Schema.Literals(["finder", "file-explorer", "files"]);
export type FileManagerRevealKind = typeof FileManagerRevealKind.Type;

export const LaunchEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
  /** Reveal (select) `cwd` in the file manager instead of opening it. Only
      honored by the "file-manager" editor; clients must check the server's
      `shellRevealInFileManager` config flag before sending this. */
  reveal: Schema.optional(Schema.Boolean),
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

const remoteOpenOf = (editor: EditorDefinition): RemoteEditorOpenDefinition | undefined =>
  editor.remoteOpen;

/** Editors that can open a remote workspace over SSH from the viewing machine. */
export const REMOTE_CAPABLE_EDITOR_IDS: ReadonlyArray<EditorId> = EDITORS.flatMap((editor) =>
  remoteOpenOf(editor) !== undefined ? [editor.id] : [],
);

export const remoteOpenDefinitionForEditor = (
  id: EditorId,
): RemoteEditorOpenDefinition | undefined => {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  return editor === undefined ? undefined : remoteOpenOf(editor);
};

/**
 * Builds the editor-specific deep link that opens `absolutePath` on `host`
 * from the viewing machine over SSH. Returns undefined for editors without
 * remote deep-link support.
 */
export const buildRemoteOpenUrl = (input: {
  readonly editor: EditorId;
  readonly host: string;
  readonly absolutePath: string;
}): string | undefined => {
  const remoteOpen = remoteOpenDefinitionForEditor(input.editor);
  if (remoteOpen === undefined) {
    return undefined;
  }
  // Windows server paths (`C:\...`) appear as `/C:/...` in remote editor URIs.
  const posixPath = input.absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encodedPath = rootedPath.split("/").map(encodeURIComponent).join("/");
  const encodedHost = encodeURIComponent(input.host);

  return `${remoteOpen.scheme}://${remoteOpen.urlHost}/${remoteOpen.sshPathPrefix}${encodedHost}${encodedPath}`;
};

/**
 * SSH hostnames an environment advertises for remote open links. Reachability
 * is client-side; the server only advertises names that resolve to itself and
 * gates them on a local sshd listen check. Ordered most-reachable first
 * (tailnet MagicDNS name, then mDNS `<hostname>.local`).
 */
export const RemoteOpenTargetKind = Schema.Literals(["tailscale", "mdns"]);
export type RemoteOpenTargetKind = typeof RemoteOpenTargetKind.Type;

export const RemoteOpenTarget = Schema.Struct({
  kind: RemoteOpenTargetKind,
  host: TrimmedNonEmptyString,
});
export type RemoteOpenTarget = typeof RemoteOpenTarget.Type;

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
