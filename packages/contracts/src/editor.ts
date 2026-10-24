import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly remoteScheme?: string;
  readonly jetbrainsProductCode?: string;
  /**
   * macOS bundle identifiers, checked through LaunchServices. On macOS the
   * editor counts as installed when one of these apps is registered or when its
   * CLI resolves into an `.app` bundle. A CLI outside any app, such as the
   * Cursor Agent `cursor` shim or `/usr/bin/xed`, does not count. An editor
   * without `commands` opens through `open -b`.
   */
  readonly macBundleIds?: readonly [string, ...string[]];
  /** The CLI's path inside the app bundle's `Contents`, when it is not `Resources/app/bin`. */
  readonly macBundleCli?: string;
  /**
   * Terminals and git clients open folders. Terminals also run a script they
   * are handed, so a file target opens its folder instead, and file actions do
   * not offer these apps.
   */
  readonly foldersOnly?: true;
  /** Opens files but runs an executable one, so an executable target opens its folder. */
  readonly runsExecutables?: true;
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
    macBundleIds: ["com.todesktop.230313mzl4w4u92"],
  },
  {
    id: "trae",
    label: "Trae",
    commands: ["trae"],
    launchStyle: "goto",
    macBundleIds: ["com.trae.app", "cn.trae.app"],
  },
  {
    id: "kiro",
    label: "Kiro",
    commands: ["kiro"],
    baseArgs: ["ide"],
    launchStyle: "goto",
    macBundleIds: ["dev.kiro.desktop"],
  },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    remoteScheme: "vscode",
    macBundleIds: ["com.microsoft.VSCode"],
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    remoteScheme: "vscode-insiders",
    macBundleIds: ["com.microsoft.VSCodeInsiders"],
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    launchStyle: "goto",
    remoteScheme: "vscodium",
    macBundleIds: ["com.vscodium"],
  },
  {
    id: "devin-desktop",
    label: "Devin Desktop",
    // Windsurf became Devin Desktop and kept its bundle id; older installs
    // still ship the `windsurf` CLI.
    commands: ["devin-desktop", "windsurf"],
    launchStyle: "goto",
    macBundleIds: ["com.exafunction.windsurf"],
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    remoteScheme: "zed",
    macBundleIds: ["dev.zed.Zed", "dev.zed.Zed-Preview", "dev.zed.Zed-Nightly"],
    macBundleCli: "MacOS/cli",
  },
  {
    id: "xcode",
    label: "Xcode",
    // `xed` opens the Xcode chosen with `xcode-select`, which matters when
    // several Xcode versions are installed.
    commands: ["xed"],
    launchStyle: "line",
    macBundleIds: ["com.apple.dt.Xcode"],
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    // `subl` reads a `path:line:column` suffix itself.
    commands: ["subl"],
    launchStyle: "direct-path",
    macBundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
    macBundleCli: "SharedSupport/bin/subl",
  },
  {
    id: "nova",
    label: "Nova",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.panic.Nova"],
  },
  {
    id: "bbedit",
    label: "BBEdit",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.barebones.bbedit"],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // `agy` is the standalone Antigravity CLI, not the IDE. The IDE bundle
    // ships `antigravity-ide`, so it comes first for install-folder lookups.
    commands: ["antigravity-ide", "agy-ide"],
    launchStyle: "goto",
    // `com.google.antigravity` is the separate Hub app.
    macBundleIds: ["com.google.antigravity-ide"],
  },
  // JetBrains EAP builds use the release bundle id with an `-EAP` suffix.
  {
    id: "idea",
    label: "IntelliJ IDEA",
    commands: ["idea"],
    launchStyle: "line-column",
    jetbrainsProductCode: "IU",
    macBundleIds: [
      "com.jetbrains.intellij",
      "com.jetbrains.intellij.ce",
      "com.jetbrains.intellij-EAP",
    ],
  },
  {
    id: "aqua",
    label: "Aqua",
    commands: ["aqua"],
    launchStyle: "line-column",
    jetbrainsProductCode: "QA",
    macBundleIds: ["com.jetbrains.aqua", "com.jetbrains.aqua-EAP"],
  },
  {
    id: "clion",
    label: "CLion",
    commands: ["clion"],
    launchStyle: "line-column",
    jetbrainsProductCode: "CL",
    macBundleIds: ["com.jetbrains.CLion", "com.jetbrains.CLion-EAP"],
  },
  {
    id: "datagrip",
    label: "DataGrip",
    commands: ["datagrip"],
    launchStyle: "line-column",
    jetbrainsProductCode: "DB",
    macBundleIds: ["com.jetbrains.datagrip", "com.jetbrains.datagrip-EAP"],
  },
  {
    id: "dataspell",
    label: "DataSpell",
    commands: ["dataspell"],
    launchStyle: "line-column",
    jetbrainsProductCode: "DS",
    macBundleIds: ["com.jetbrains.dataspell", "com.jetbrains.dataspell-EAP"],
  },
  {
    id: "goland",
    label: "GoLand",
    commands: ["goland"],
    launchStyle: "line-column",
    jetbrainsProductCode: "GO",
    macBundleIds: ["com.jetbrains.goland", "com.jetbrains.goland-EAP"],
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    commands: ["phpstorm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "PS",
    macBundleIds: ["com.jetbrains.PhpStorm", "com.jetbrains.PhpStorm-EAP"],
  },
  {
    id: "pycharm",
    label: "PyCharm",
    commands: ["pycharm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "PY",
    macBundleIds: [
      "com.jetbrains.pycharm",
      "com.jetbrains.pycharm.ce",
      "com.jetbrains.pycharm-EAP",
    ],
  },
  {
    id: "rider",
    label: "Rider",
    commands: ["rider"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RD",
    macBundleIds: ["com.jetbrains.rider", "com.jetbrains.rider-EAP"],
  },
  {
    id: "rubymine",
    label: "RubyMine",
    commands: ["rubymine"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RM",
    macBundleIds: ["com.jetbrains.rubymine", "com.jetbrains.rubymine-EAP"],
  },
  {
    id: "rustrover",
    label: "RustRover",
    commands: ["rustrover"],
    launchStyle: "line-column",
    jetbrainsProductCode: "RR",
    macBundleIds: ["com.jetbrains.rustrover", "com.jetbrains.rustrover-EAP"],
  },
  {
    id: "webstorm",
    label: "WebStorm",
    commands: ["webstorm"],
    launchStyle: "line-column",
    jetbrainsProductCode: "WS",
    macBundleIds: ["com.jetbrains.WebStorm", "com.jetbrains.WebStorm-EAP"],
  },
  {
    id: "android-studio",
    label: "Android Studio",
    commands: ["studio"],
    launchStyle: "line-column",
    macBundleIds: ["com.google.android.studio"],
  },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
  // Terminals and git clients follow the file manager, so the default Open
  // target on a Mac without an editor stays Finder rather than Terminal.
  {
    id: "terminal",
    label: "Terminal",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.apple.Terminal"],
    foldersOnly: true,
  },
  {
    id: "iterm2",
    label: "iTerm2",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.googlecode.iterm2"],
    foldersOnly: true,
  },
  {
    id: "ghostty",
    label: "Ghostty",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.mitchellh.ghostty"],
    foldersOnly: true,
  },
  {
    id: "kitty",
    label: "kitty",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["net.kovidgoyal.kitty"],
    foldersOnly: true,
  },
  {
    id: "wezterm",
    label: "WezTerm",
    // WezTerm ignores a folder handed over by LaunchServices and opens in the
    // home folder, so it starts through its CLI.
    commands: ["wezterm"],
    baseArgs: ["start", "--cwd"],
    launchStyle: "direct-path",
    macBundleIds: ["com.github.wez.wezterm"],
    macBundleCli: "MacOS/wezterm",
    foldersOnly: true,
  },
  {
    id: "warp",
    label: "Warp",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["dev.warp.Warp-Stable", "dev.warp.Warp-Preview"],
    // Warp edits files in its own editor, but runs a file with the executable bit.
    runsExecutables: true,
  },
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.github.GitHubClient"],
    foldersOnly: true,
  },
  {
    id: "fork",
    label: "Fork",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.DanPristupov.Fork"],
    foldersOnly: true,
  },
  {
    id: "sourcetree",
    label: "Sourcetree",
    commands: null,
    launchStyle: "direct-path",
    macBundleIds: ["com.torusknot.SourceTreeNotMAS"],
    foldersOnly: true,
  },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

const FOLDER_ONLY_EDITOR_IDS: ReadonlySet<EditorId> = new Set(
  EDITORS.flatMap((editor) => ("foldersOnly" in editor ? [editor.id] : [])),
);

export const editorOpensFiles = (id: EditorId): boolean => !FOLDER_ONLY_EDITOR_IDS.has(id);

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
    // Zed's remote server resolves a rooted path on the system drive, so a
    // Windows `C:\Users\x` must become `/Users/x` (verified in #8938). Other
    // drives are untested and kept as is rather than silently remapped, and a
    // POSIX path that happens to start with `/C:` is left alone.
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
