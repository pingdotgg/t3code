import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { environmentThreadDetails } from "../../state/threads";
import { WorkspaceMutationIdContext } from "./workspaceMutationIdContext";

const NO_WORKSPACE_MUTATION_ID_ATOM = Atom.make<string | null | undefined>(undefined);

export function WorkspaceMutationIdProvider(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const workspaceMutationId = useAtomValue(
    props.threadRef === null
      ? NO_WORKSPACE_MUTATION_ID_ATOM
      : environmentThreadDetails.workspaceMutationIdAtom(props.threadRef),
  );
  return (
    <WorkspaceMutationIdContext value={workspaceMutationId}>
      {props.children}
    </WorkspaceMutationIdContext>
  );
}
