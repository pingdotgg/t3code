import {
  AuthTerminalOperateScope,
  isTerminalEditor,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { useRemoteCapableEditors, type RemoteOpenMode } from "../../remoteOpen";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";

/** Launchable editors follow the open mode; terminal editors always run on the thread's environment. */
export function useOpenInEditors(
  environmentId: EnvironmentId,
  availableEditors: ReadonlyArray<EditorId>,
  remoteMode: RemoteOpenMode,
): ReadonlyArray<EditorId> {
  const remoteCapableEditors = useRemoteCapableEditors();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const launchable = remoteMode === "local-exec" ? availableEditors : remoteCapableEditors;
  return [
    ...launchable.filter((id) => !isTerminalEditor(id)),
    ...(canOperateTerminal ? (serverConfig?.availableEditors ?? []).filter(isTerminalEditor) : []),
  ];
}
