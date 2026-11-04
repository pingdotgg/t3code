import type { ServerEventLoopStall } from "@t3tools/contracts";

export interface HostFreezeNotice {
  readonly title: string;
  readonly description: string;
}

// Below this, a load above the core count is mostly tasks blocked on I/O, not running.
const CPU_SATURATED = 0.8;

/**
 * Says why a host stopped answering, from the recent stall it reports on
 * connect. Web shows it as a toast, mobile in the environment's connection row.
 */
export function hostFreezeNotice(
  hostLabel: string,
  stall: ServerEventLoopStall | undefined,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  return {
    title: `${hostLabel} froze for ${Math.round(stall.durationMs / 1000)}s`,
    description: describeCause(hostLabel, stall),
  };
}

function describeCause(
  hostLabel: string,
  { loadAverage, cpuBusy, cpuCount }: ServerEventLoopStall,
): string {
  if (loadAverage === undefined || loadAverage <= cpuCount) {
    return `T3 Code on ${hostLabel} was too busy to answer.`;
  }
  const load = `load ${Math.round(loadAverage)} on ${cpuCount} cores`;
  if (cpuBusy === undefined) return `The host is overloaded (${load}).`;
  const busy = Math.round(cpuBusy * 100);
  return cpuBusy >= CPU_SATURATED
    ? `Its CPU is overloaded (${load}, ${busy}% busy).`
    : `Its processes are waiting on disk or other I/O (${load}, CPU only ${busy}% busy).`;
}
