import type { EDITORS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "./HostProcess.ts";
import { isCommandAvailable, resolveCommandPath } from "./shell.ts";

type Editor = (typeof EDITORS)[number];

const installNames: Partial<Record<Editor["id"], ReadonlyArray<string>>> = {
  vscode: ["Visual Studio Code"],
  "vscode-insiders": ["Visual Studio Code - Insiders"],
  // `Antigravity.app` is the separate Hub, not the IDE.
  antigravity: ["Antigravity IDE"],
  idea: ["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"],
  pycharm: ["PyCharm", "PyCharm CE"],
  rider: ["Rider", "JetBrains Rider"],
};

/**
 * A plain prefix match would let one editor steal another's bundle, e.g. stable VS Code resolving to
 * `Visual Studio Code - Insiders.app`. */
const isVersionedBundle = (entry: string, name: string) => {
  if (!entry.startsWith(`${name} `) || !entry.endsWith(".app")) return false;
  return /^\d[\d.]*$/.test(entry.slice(name.length + 1, -".app".length));
};

const resolveEditorCommand = Effect.fn("editor.resolveEditorCommand")(function* (
  editor: Editor,
  env: NodeJS.ProcessEnv,
  // The app LaunchServices registered for this editor. Its own CLI is tried
  // before PATH, so a same-named shim cannot stand in for it.
  macAppPath?: string,
) {
  if (editor.commands === null) return Option.none();
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  const platform = yield* HostProcess.Platform;
  // OpenZFS also installs a `zed` executable. Prefer the macOS editor bundle
  // so a PATH entry for the ZFS Event Daemon cannot take over editor opens.
  const preferBundle = platform === "darwin" && (editor.id === "zed" || macAppPath !== undefined);
  if (!preferBundle) {
    for (const command of editor.commands) {
      if (yield* isCommandAvailable(command, { env })) return Option.some({ command, baseArgs });
    }
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = env.HOME;
  const names = installNames[editor.id] ?? [editor.label];
  const command = editor.commands[0];
  const jetbrains = editor.launchStyle === "line-column";
  const candidates: string[] = [];
  const bundleCommands = (appPath: string) => {
    const contents = path.join(appPath, "Contents");
    if ("macBundleCli" in editor) return [path.join(contents, editor.macBundleCli)];
    return jetbrains
      ? [path.join(contents, "MacOS", command)]
      : [
          ...editor.commands.map((name) => path.join(contents, "Resources/app/bin", name)),
          path.join(contents, "Resources/app/bin/code"),
        ];
  };

  if (platform === "darwin" && macAppPath !== undefined) {
    candidates.push(...bundleCommands(macAppPath));
  } else if (platform === "darwin") {
    const roots = [...(home ? [path.join(home, "Applications")] : []), "/Applications"];
    for (const root of roots) {
      // JetBrains Toolbox installs bundles named after the app and its version
      // (`IntelliJ IDEA 2026.1.4.app`), so list the directory and accept
      // `<name> <version>.app` as well as the exact `<name>.app`.
      const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const bundles = new Set(names.map((name) => `${name}.app`));
      for (const entry of entries) {
        if (names.some((name) => entry === `${name}.app` || isVersionedBundle(entry, name))) {
          bundles.add(entry);
        }
      }
      for (const bundle of bundles) {
        candidates.push(...bundleCommands(path.join(root, bundle)));
      }
    }
    if (home && jetbrains) {
      candidates.push(
        path.join(home, "Library/Application Support/JetBrains/Toolbox/scripts", command),
      );
    }
  } else if (platform === "win32") {
    const roots = [
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Programs")] : []),
      ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(
        (root): root is string => !!root,
      ),
    ];
    if (jetbrains) {
      if (env.LOCALAPPDATA) {
        candidates.push(path.join(env.LOCALAPPDATA, "JetBrains/Toolbox/scripts", `${command}.cmd`));
      }
      for (const directory of roots.flatMap((root) => [root, path.join(root, "JetBrains")])) {
        const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          if (names.some((name) => entry === name || entry.startsWith(`${name} `))) {
            candidates.push(path.join(directory, entry, "bin", `${command}64.exe`));
            candidates.push(path.join(directory, entry, "bin", `${command}.exe`));
          }
        }
      }
    } else {
      const name =
        editor.id === "vscode"
          ? "Microsoft VS Code"
          : editor.id === "vscode-insiders"
            ? "Microsoft VS Code Insiders"
            : editor.label;
      for (const root of roots) {
        candidates.push(
          path.join(root, name, "resources/app/bin", `${command}.cmd`),
          path.join(root, name, "resources/app/bin/code.cmd"),
          path.join(root, name, "bin", `${command}.cmd`),
          path.join(root, name, "bin/code.cmd"),
        );
        if (editor.id === "zed") {
          candidates.push(
            path.join(root, name, "bin", "zed.exe"),
            path.join(root, name, "zed.exe"),
          );
        }
      }
    }
  } else if (platform === "linux") {
    const dirs = [
      ...(home ? [path.join(home, ".local/bin")] : []),
      "/usr/local/bin",
      "/usr/bin",
      "/snap/bin",
    ];
    if (jetbrains) {
      const dataHome = env.XDG_DATA_HOME || (home ? path.join(home, ".local/share") : undefined);
      if (dataHome) dirs.push(path.join(dataHome, "JetBrains/Toolbox/scripts"));
    }
    for (const dir of dirs) {
      for (const name of editor.commands) candidates.push(path.join(dir, name));
    }
  }

  for (const candidate of candidates) {
    if (yield* isCommandAvailable(candidate, { env })) {
      return Option.some({
        command: candidate,
        // The IDE's own bundled CLI opens paths directly; the `kiro` on PATH may
        // be the Kiro CLI, which needs the `ide` subcommand.
        baseArgs:
          editor.id === "kiro" && (platform === "darwin" || platform === "win32") ? [] : baseArgs,
      });
    }
  }
  if (preferBundle) {
    for (const command of editor.commands) {
      if (yield* isCommandAvailable(command, { env })) return Option.some({ command, baseArgs });
    }
  }
  return Option.none();
});

/** Bundle id to app path, for the requested ids LaunchServices has registered. */
type MacApplications = ReadonlyMap<string, string>;

const MAC_APPLICATIONS_SCRIPT = `ObjC.import("AppKit");
function run(bundleIds) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const found = {};
  for (const id of bundleIds) {
    const url = workspace.URLForApplicationWithBundleIdentifier(id);
    if (!url.isNil()) found[id] = ObjC.unwrap(url.path);
  }
  return JSON.stringify(found);
}`;

const decodeMacApplications = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
 * Asks LaunchServices which of `bundleIds` are installed, in one `osascript`
 * call through the AppKit bridge. Bundle ids are used instead of URL schemes
 * because schemes resolve too loosely: `xcode://` finds a helper app inside an
 * old Xcode and `idea://` finds Android Studio. None means the answer is
 * unknown (not macOS, or `osascript` missing or blocked), and callers fall back
 * to PATH discovery.
 */
export const resolveMacApplications = Effect.fn("editor.resolveMacApplications")(function* (
  bundleIds: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  if ((yield* HostProcess.Platform) !== "darwin" || bundleIds.length === 0) {
    return Option.none<MacApplications>();
  }
  if (!(yield* isCommandAvailable("osascript", { env }))) return Option.none<MacApplications>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .spawn(
      ChildProcess.make(
        "osascript",
        ["-l", "JavaScript", "-e", MAC_APPLICATIONS_SCRIPT, ...bundleIds],
        {
          stdin: "ignore",
          stderr: "ignore",
        },
      ),
    )
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
          concurrency: "unbounded",
        }),
      ),
      Effect.flatMap(([stdout, exitCode]) =>
        exitCode === 0
          ? decodeMacApplications(stdout.trim()).pipe(
              Effect.map((apps) => Option.some<MacApplications>(new Map(Object.entries(apps)))),
            )
          : Effect.succeed(Option.none<MacApplications>()),
      ),
      Effect.scoped,
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => Option.none()),
    );
});

export const macBundleIdsOf = (editor: Editor): ReadonlyArray<string> =>
  "macBundleIds" in editor ? editor.macBundleIds : [];

type EditorInstall =
  | { readonly kind: "command"; readonly command: string; readonly baseArgs: ReadonlyArray<string> }
  | { readonly kind: "mac-app"; readonly bundleId: string };

const resolvesIntoAppBundle = Effect.fn("editor.resolvesIntoAppBundle")(function* (
  command: string,
  env: NodeJS.ProcessEnv,
) {
  const commandPath = yield* resolveCommandPath(command, { env });
  if (commandPath === null) return false;
  const fs = yield* FileSystem.FileSystem;
  const realPath = yield* fs.realPath(commandPath).pipe(Effect.orElseSucceed(() => commandPath));
  return realPath.includes(".app/Contents/");
});

/**
 * How to open `editor` on this host, or none when it is not installed. When
 * LaunchServices answered, an editor with bundle ids needs one of those apps,
 * or a CLI that resolves into an app bundle: LaunchServices can miss an app
 * that was copied in by hand and never opened. A registered app opens through
 * its own CLI when it has one, otherwise `open -b`.
 */
export const resolveEditorInstall = Effect.fn("editor.resolveEditorInstall")(function* (
  editor: Editor,
  env: NodeJS.ProcessEnv,
  macApps: Option.Option<MacApplications>,
) {
  const bundleIds = macBundleIdsOf(editor);
  if (Option.isNone(macApps) || bundleIds.length === 0) {
    const command = yield* resolveEditorCommand(editor, env);
    return Option.map(command, (resolved): EditorInstall => ({ kind: "command", ...resolved }));
  }
  const bundleId = bundleIds.find((id) => macApps.value.has(id));
  if (bundleId === undefined) {
    // LaunchServices lists apps in the standard folders, so only a PATH CLI
    // linked into an app it missed can still prove an install.
    for (const command of editor.commands ?? []) {
      if (yield* resolvesIntoAppBundle(command, env)) {
        // The linked CLI is the app's own, which Kiro's needs no `ide` subcommand for.
        const baseArgs = "baseArgs" in editor && editor.id !== "kiro" ? editor.baseArgs : [];
        return Option.some<EditorInstall>({ kind: "command", command, baseArgs });
      }
    }
    return Option.none<EditorInstall>();
  }
  const command = yield* resolveEditorCommand(editor, env, macApps.value.get(bundleId));
  return Option.some<EditorInstall>(
    Option.isSome(command) ? { kind: "command", ...command.value } : { kind: "mac-app", bundleId },
  );
});
