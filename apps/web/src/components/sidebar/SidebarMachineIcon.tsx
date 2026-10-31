import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { MachineStatusIcon } from "../ConnectionStatusDot";

// Rows read the phase alone, so a new attempt or route result does not re-render them.
const connectionPhaseAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ?? null,
  ),
);

/** A remote machine's icon, with a dot only while that machine is not connected. */
export function SidebarMachineIcon({
  environmentId,
  kind,
}: {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentMachineKind;
}) {
  const phase = useAtomValue(connectionPhaseAtom(environmentId));
  return (
    <MachineStatusIcon
      kind={kind}
      phase={phase === "connected" ? null : phase}
      className="size-3.5"
    />
  );
}
