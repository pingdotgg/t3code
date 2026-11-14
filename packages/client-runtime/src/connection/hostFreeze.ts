import type { ServerEventLoopStall } from "@t3tools/contracts";

export interface HostFreezeNotice {
  readonly title: string;
  readonly description: string;
}

/**
 * Says why a host stopped answering, from the recent stall it reports on
 * connect. Web shows it as a toast, mobile in the environment's connection row.
 */
export function hostFreezeNotice(
  hostLabel: string,
  stall: ServerEventLoopStall | undefined,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: `${hostLabel} froze for ${Math.round(stall.durationMs / 1000)}s`,
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? `Its CPU is overloaded (load ${Math.round(loadAverage)} on ${cpuCount} cores).`
        : `T3 Code on ${hostLabel} was too busy to answer.`,
  };
}
