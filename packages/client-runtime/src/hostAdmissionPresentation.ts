import type { HostAdmissionState, OrchestrationV2AdmissionWait } from "@t3tools/contracts";

/** Why a queued run waits for the host; counts are omitted when the host's state is unknown. */
export function hostAdmissionWaitReason(
  wait: OrchestrationV2AdmissionWait | undefined,
  admission: HostAdmissionState | undefined,
): string | null {
  if (wait === "capacity") {
    return admission?.maxRunningTurns
      ? `Waiting for a free slot (${admission.runningTurns}/${admission.maxRunningTurns} running)`
      : "Waiting for a free slot";
  }
  if (wait === "host_load") {
    return admission?.pacing === "severe"
      ? "Waiting for the host: memory is critically low"
      : "Starting turns one at a time while the host is busy";
  }
  return null;
}

/** Why the host holds new turns right now; the cap comes first, as on the server. */
export function hostAdmissionHoldReason(admission: HostAdmissionState): string | null {
  const atCap =
    admission.maxRunningTurns !== null && admission.runningTurns >= admission.maxRunningTurns;
  return hostAdmissionWaitReason(
    atCap ? "capacity" : admission.pacing === null ? undefined : "host_load",
    admission,
  );
}

export function hostAdmissionWaitingLabel(admission: HostAdmissionState): string {
  return `${admission.waitingTurns} ${admission.waitingTurns === 1 ? "turn" : "turns"} waiting`;
}

/** "2 turns waiting · 4/4 running" */
export function hostAdmissionSummary(admission: HostAdmissionState): string {
  const running =
    admission.maxRunningTurns === null
      ? `${admission.runningTurns} running`
      : `${admission.runningTurns}/${admission.maxRunningTurns} running`;
  return `${hostAdmissionWaitingLabel(admission)} · ${running}`;
}

/** "4 running · 2 waiting" */
export function hostAdmissionCounts(admission: HostAdmissionState): string {
  return `${admission.runningTurns} running · ${admission.waitingTurns} waiting`;
}
