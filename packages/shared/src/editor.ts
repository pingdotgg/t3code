import type { EDITORS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";
import { isCommandAvailable, resolveCommandPath, resolveCommandPaths } from "./shell.ts";

type Editor = (typeof EDITORS)[number];

// The nearest Zed folder identifies the channel, even below a user named zedpreview.
const isPrereleaseZedPath = (filePath: string) => {
  const install = filePath
    .split(/[\\/]/)
    .slice(0, -1)
    .findLast((folder) => folder.toLowerCase().includes("zed"))
    ?.toLowerCase();
  return install !== undefined && (install.includes("nightly") || install.includes("preview"));
};

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

// OpenZFS's event daemon is also named zed; it rejects `--version` instead of starting.
const isZedEditor = Effect.fn("editor.isZedEditor")(
  function* (command: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, ["--version"], {
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.runHead), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return exitCode === 0 && Option.getOrElse(stdout, () => "").startsWith("Zed");
  },
  Effect.scoped,
  Effect.timeout("2 seconds"),
  Effect.catchCause(() => Effect.succeed(false)),
);

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
  if (platform === "win32" && editor.id === "zed") {
    const isStable = (resolved: string) => !isPrereleaseZedPath(resolved);
    let firstCommand: string | undefined;
    for (const command of editor.commands) {
      const matches = yield* resolveCommandPaths(command, { env, until: isStable });
      const stable = matches.find(isStable);
      // Bypass PATH only when stable is behind a prerelease install.
      if (stable !== undefined) {
        const isFirst = firstCommand === undefined && stable === matches[0];
        return Option.some({ command: isFirst ? command : stable, baseArgs });
      }
      if (firstCommand === undefined && matches.length > 0) firstCommand = command;
    }
    if (firstCommand !== undefined) return Option.some({ command: firstCommand, baseArgs });
  } else if (!preferBundle && !preferZeditor) {
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
  let toolbox: { dir: string; suffix: string } | undefined;

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
      toolbox = {
        dir: path.join(home, "Library/Application Support/JetBrains/Toolbox/scripts"),
        suffix: "",
      };
      candidates.push(path.join(toolbox.dir, command));
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
        toolbox = { dir: path.join(env.LOCALAPPDATA, "JetBrains/Toolbox/scripts"), suffix: ".cmd" };
        candidates.push(path.join(toolbox.dir, `${command}.cmd`));
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
    const dataHome = env.XDG_DATA_HOME || (home ? path.join(home, ".local/share") : undefined);
    if (jetbrains && dataHome) {
      toolbox = { dir: path.join(dataHome, "JetBrains/Toolbox/scripts"), suffix: "" };
      dirs.push(toolbox.dir);
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
  if (toolbox) {
    // Toolbox names a launch script `idea1`, `idea2`, ... while `idea` is taken, and keeps that
    // name after the other install is removed. Try these only after every canonical candidate.
    const { dir, suffix } = toolbox;
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    candidates.push(
      ...entries
        .filter(
          (entry) =>
            entry.startsWith(command) &&
            entry.endsWith(suffix) &&
            /^\d+$/.test(entry.slice(command.length, entry.length - suffix.length)),
        )
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .map((entry) => path.join(dir, entry)),
    );
  }
  const rejected = new Set<string>();
  for (const candidate of candidates) {
    const resolved = yield* resolveCommandPath(candidate, { env });
    if (resolved === null || rejected.has(resolved)) continue;
    if (preferZeditor && path.basename(candidate) === "zed" && !(yield* isZedEditor(resolved))) {
      rejected.add(resolved);
      continue;
    }
    return Option.some({
      command: candidate,
      baseArgs:
        editor.id === "kiro" && (platform === "darwin" || platform === "win32") ? [] : baseArgs,
    });
  }
  return Option.none();
});
