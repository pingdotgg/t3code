import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useId, useState, type ReactNode } from "react";

import { environmentThreadDetails } from "../../state/threads";
import { ThreadMediaVisitContext, WorkspaceMutationIdContext } from "./workspaceMutationIdContext";

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
  const screenId = useId();
  const focused = useIsFocused();
  const [visit, setVisit] = useState({ focused, number: 0 });
  if (focused !== visit.focused) {
    setVisit({ focused, number: visit.number + (focused ? 1 : 0) });
  }
  return (
    <WorkspaceMutationIdContext value={workspaceMutationId}>
      <ThreadMediaVisitContext value={`${screenId}:${visit.number}`}>
        {props.children}
      </ThreadMediaVisitContext>
    </WorkspaceMutationIdContext>
  );
}
