import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EditorId,
  type EnvironmentId,
  type ProjectEntry,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { failureText } from "../settings/failureText";
import { localState } from "./boards";

const listEntries = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:files:list-entries",
  tag: WS_METHODS.projectsListEntries,
});
const openInEditorCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:files:open-in-editor",
  tag: WS_METHODS.shellOpenInEditor,
});

/** The entries directly inside a directory, which is relative to `cwd`. A failure throws the engine's own reason. */
export async function listFolder(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath: string,
): Promise<ReadonlyArray<ProjectEntry>> {
  const result = await runAtomCommand(
    registry,
    listEntries,
    { environmentId, input: { cwd, directoryPath } },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value.entries;
  throw new Error(failureText(result));
}

/** The editor the user opened a file in last. The saved choice replaces null on launch. */
export const lastEditorAtom = Atom.writable(
  (get): string | null => {
    void localState.read().then((state) => get.setSelf(state.lastEditor));
    return null;
  },
  (context, editor: string) => context.setSelf(editor),
).pipe(Atom.keepAlive, Atom.withLabel("last-editor"));

/**
 * Opens a file in an editor T3 launches on the engine's host. `path` is absolute, and `root` is the
 * workspace it belongs to. A refusal returns T3's own reason, and a launch returns null.
 */
export async function openInEditor(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  editor: EditorId,
  path: string,
  root: string,
): Promise<string | null> {
  const result = await runAtomCommand(
    registry,
    openInEditorCommand,
    { environmentId, input: { cwd: path, editor, position: {}, projectRoot: root } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") return failureText(result);
  registry.set(lastEditorAtom, editor);
  void localState.update((state) => ({ ...state, lastEditor: editor }));
  return null;
}
