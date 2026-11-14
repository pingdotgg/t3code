import * as NodePath from "@effect/platform-node/NodePath";
import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  ExternalLauncherUnsupportedTargetError,
  type EditorId,
  type FileManagerRevealKind,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isCommandAvailable,
  resolveSpawnCommand,
  withPathDirectoryListings,
} from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeStaleWhileRevalidate } from "../environment/staleWhileRevalidate.ts";
import type { EditorLaunch } from "./externalLauncher.ts";
import { normalizeWindowsFileManagerPath, readBrowserLaunchEnv, readCommandLookupEnv, resolveCommandEditorArgs, resolveFileManagerRevealLaunch, resolveUsableFileManagerCommand, resolveWslFileManagerPath } from "./externalLauncher.ts";

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<
  EditorLaunch,
  ExternalLauncherError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const platform = yield* HostProcess.Platform;
  const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const { command, baseArgs } = Option.getOrElse(
      yield* resolveEditorCommand(editorDef, env),
      () => ({
        command: editorDef.commands[0],
        baseArgs: "baseArgs" in editorDef ? editorDef.baseArgs : [],
      }),
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: [...baseArgs, ...resolveCommandEditorArgs(editorDef, input.cwd)],
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  const command = yield* resolveUsableFileManagerCommand(platform, env);
  if (command === undefined) {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  if (input.reveal === true) {
    return yield* resolveFileManagerRevealLaunch(input.cwd, platform, env, command);
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command,
    args:
      command === "explorer.exe" && env.WSL_DISTRO_NAME !== undefined
        ? [resolveWslFileManagerPath(input.cwd, env.WSL_DISTRO_NAME)]
        : platform === "win32"
          ? // Explorer interprets / as a switch and silently opens a fallback folder.
            [normalizeWindowsFileManagerPath(input.cwd)]
          : [input.cwd],
  };
});

// A replacement manager registers a default Directory shell verb; stock Windows
// uses "none". Explorer needs its /select argument passed verbatim through
// PowerShell because Node's argument quoting changes how Explorer parses it.
