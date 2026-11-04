import {
  AuthTerminalOperateScope,
  buildTerminalEditorCommand,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";

import { readEnvironmentScope } from "./state/session";

interface TerminalEditorHost {
  readonly environmentId: EnvironmentId;
  readonly open: (command: string) => Promise<void>;
}

// Openers span the drawer, panels and per-message links; one slot avoids a subscription in each.
let activeHost: TerminalEditorHost | null = null;

/** Publishes the foreground thread as the place terminal editors open. Returns the unregister. */
export function registerTerminalEditorHost(host: TerminalEditorHost): () => void {
  activeHost = host;
  return () => {
    if (activeHost === host) activeHost = null;
  };
}

export function canOpenTerminalEditor(environmentId: EnvironmentId): boolean {
  return (
    activeHost?.environmentId === environmentId &&
    readEnvironmentScope(environmentId, AuthTerminalOperateScope)
  );
}

export async function openInTerminalEditor(
  environmentId: EnvironmentId,
  editor: EditorId,
  target: string,
): Promise<boolean> {
  const command = buildTerminalEditorCommand(editor, target);
  if (command === undefined || activeHost === null || !canOpenTerminalEditor(environmentId)) {
    return false;
  }
  await activeHost.open(command);
  return true;
}
