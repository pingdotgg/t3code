import {
  EDITORS,
  type DesktopOpenLocalEditorInput,
  type DesktopOpenLocalEditorResult,
} from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TARGET_WITH_POSITION = /^(.*?):(\d+)(?::(\d+))?$/;

const refuse = (
  reason: Extract<DesktopOpenLocalEditorResult, { ok: false }>["reason"],
): DesktopOpenLocalEditorResult => ({ ok: false, reason });

// Mirrors the server launcher's argv per launch style; the path stays the last, absolute argument.
function editorArguments(
  launchStyle: (typeof EDITORS)[number]["launchStyle"],
  path: string,
  position: { readonly line: string; readonly column: string | undefined } | null,
): ReadonlyArray<string> {
  if (position === null) return [path];
  const target = `${path}:${position.line}${position.column === undefined ? "" : `:${position.column}`}`;
  // Zed's CLI reads `path:line:column` as a plain argument.
  if (launchStyle === "direct-path") return [target];
  if (launchStyle === "goto") return ["--goto", target];
  return [
    "--line",
    position.line,
    // JetBrains IDEs count `--column` from 0; targets count columns from 1.
    ...(position.column === undefined
      ? []
      : ["--column", String(Math.max(0, Number(position.column) - 1))]),
    path,
  ];
}

// Absolute, existing paths cannot become options or silently create files on the wrong device.
export const launchLocalEditor = Effect.fn("desktop.localEditor.launch")(function* (
  input: DesktopOpenLocalEditorInput,
): Effect.fn.Return<
  DesktopOpenLocalEditorResult,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const editor = EDITORS.find((candidate) => candidate.id === input.editor);
  if (editor === undefined || editor.commands === null) return refuse("unsupported-editor");

  const path = yield* Path.Path;
  if (!path.isAbsolute(input.path) || CONTROL_CHARACTERS.test(input.path)) {
    return refuse("invalid-path");
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  // An existing file literally named `a:12` wins over reading `:12` as a line.
  let targetPath = input.path;
  let position: { readonly line: string; readonly column: string | undefined } | null = null;
  if (!(yield* exists(input.path))) {
    const match = TARGET_WITH_POSITION.exec(input.path);
    if (match?.[1] === undefined || match[2] === undefined || !(yield* exists(match[1]))) {
      return refuse("path-missing");
    }
    targetPath = match[1];
    position = { line: match[2], column: match[3] };
  }

  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = yield* HostProcess.Environment;
  const resolved = yield* resolveEditorCommand(editor, env);
  if (Option.isNone(resolved)) return refuse("editor-unavailable");

  const spawnCommand = yield* resolveSpawnCommand(
    resolved.value.command,
    [...resolved.value.baseArgs, ...editorArguments(editor.launchStyle, targetPath, position)],
    { env },
  );
  // Windows `.cmd`/`.bat` launchers need a shell, which this path never uses.
  if (spawnCommand.shell) return refuse("unsupported-launcher");

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env,
        extendEnv: false,
      }),
    )
    .pipe(
      Effect.flatMap((handle) => handle.unref),
      Effect.scoped,
      Effect.as<DesktopOpenLocalEditorResult>({ ok: true }),
      Effect.orElseSucceed(() => refuse("spawn-failed")),
    );
});
