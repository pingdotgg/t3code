import type { ServerEventLoopStall } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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
  resolve: MFunctionType = mFallback,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: resolve(
      msg("{host} froze for {seconds}s", {
        host: hostLabel,
        seconds: Math.round(stall.durationMs / 1000),
      }),
    ),
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? resolve(
            msg("Its CPU is overloaded (load {load} on {cpuCount} cores).", {
              load: Math.round(loadAverage),
              cpuCount,
            }),
          )
        : resolve(msg("Ada on {host} was too busy to answer.", { host: hostLabel })),
  };
}
