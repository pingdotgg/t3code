import type { EDITORS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as HostProcess from "./HostProcess.ts";
import { isCommandAvailable } from "./shell.ts";

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

// Prefix-only matches could select Insiders when resolving stable VS Code.
const isVersionedBundle = (entry: string, name: string) => {
  if (!entry.startsWith(`${name} `) || !entry.endsWith(".app")) return false;
  return /^\d[\d.]*$/.test(entry.slice(name.length + 1, -".app".length));
};

export const resolveEditorCommand = Effect.fn("editor.resolveEditorCommand")(function* (
  editor: Editor,
  env: NodeJS.ProcessEnv,
) {
  if (editor.commands === null) return Option.none();
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  const platform = yield* HostProcess.Platform;
  // Prefer Zed's macOS bundle because OpenZFS also installs a zed executable.
  const preferBundle = platform === "darwin" && editor.id === "zed";
  const preferZeditor = platform === "linux" && editor.id === "zed";
  if (!preferBundle && !preferZeditor) {
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

  if (platform === "darwin") {
    const roots = [...(home ? [path.join(home, "Applications")] : []), "/Applications"];
    for (const root of roots) {
      // JetBrains Toolbox appends versions to bundle names; accept exact and versioned names.
      const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const bundles = new Set(names.map((name) => `${name}.app`));
      for (const entry of entries) {
        if (names.some((name) => entry === `${name}.app` || isVersionedBundle(entry, name))) {
          bundles.add(entry);
        }
      }
      for (const bundle of bundles) {
        const contents = path.join(root, bundle, "Contents");
        candidates.push(
          ...(jetbrains || editor.id === "zed"
            ? [path.join(contents, "MacOS", editor.id === "zed" ? "cli" : command)]
            : [
                path.join(contents, "Resources/app/bin", command),
                path.join(contents, "Resources/app/bin/code"),
              ]),
        );
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
    if (preferZeditor) {
      // Linux packages use zeditor because OpenZFS owns the zed command.
      for (const name of ["zeditor", "zed"]) {
        candidates.push(name, ...dirs.map((dir) => path.join(dir, name)));
      }
    } else {
      for (const dir of dirs) {
        for (const name of editor.commands) candidates.push(path.join(dir, name));
      }
    }
  }

  if (preferBundle) candidates.push(...editor.commands);
  for (const candidate of candidates) {
    if (yield* isCommandAvailable(candidate, { env })) {
      return Option.some({
        command: candidate,
        baseArgs:
          editor.id === "kiro" && (platform === "darwin" || platform === "win32") ? [] : baseArgs,
      });
    }
  }
  return Option.none();
});
