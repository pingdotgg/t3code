import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface TeamJoinDialogRequest {
  readonly serverUrl: string;
  readonly token: string;
  readonly prefilledPseudo: string | null;
}

export const teamJoinDialogRequestAtom = Atom.make<TeamJoinDialogRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:join-dialog-request"),
);

export function openTeamJoinDialog(request: TeamJoinDialogRequest): void {
  appAtomRegistry.set(teamJoinDialogRequestAtom, request);
}

export function closeTeamJoinDialog(): void {
  appAtomRegistry.set(teamJoinDialogRequestAtom, null);
}
