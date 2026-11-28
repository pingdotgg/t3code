import { useAtomValue } from "@effect/atom-react";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ModelSelection,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";

export interface NewBotDraft {
  readonly environmentId: EnvironmentId;
  /** Null until picked: the machine's default model applies. */
  readonly modelSelection: ModelSelection | null;
}

/** The form lives in an atom, so it survives while the model picker is on top of it. */
export const newBotDraftAtom = Atom.make<NewBotDraft | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("bots:new-bot-draft"),
);

export function startNewBotDraft(environmentId: EnvironmentId): void {
  appAtomRegistry.set(newBotDraftAtom, { environmentId, modelSelection: null });
}

export function updateNewBotDraft(update: (draft: NewBotDraft) => NewBotDraft): void {
  const draft = appAtomRegistry.get(newBotDraftAtom);
  if (draft !== null) appAtomRegistry.set(newBotDraftAtom, update(draft));
}

export function useNewBotDraft(): NewBotDraft | null {
  return useAtomValue(newBotDraftAtom);
}

export interface BotMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

/** Connected machines that can host a Bot: it runs in a scratch folder there. */
export function useBotMachines(): ReadonlyArray<BotMachine> {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const serverConfigs = useServerConfigs();
  const canOperate = useEnvironmentsWithScope(connectedEnvironments, AuthOrchestrationOperateScope);
  return connectedEnvironments
    .filter(
      (environment) =>
        canOperate.has(environment.environmentId) &&
        availableScratchWorkspaceRoot(
          environment.connectionState,
          serverConfigs.get(environment.environmentId),
        ) !== null,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      machine: resolveEnvironmentMachineKind(serverConfigs.get(environment.environmentId) ?? null),
    }));
}
