/**
 * PortDiscovery - Discovers listening localhost ports and attributes them to
 * registered terminal process families.
 *
 * Reference-counted polling: the scanner only runs when at least one client
 * has called `retain()`. This keeps idle desktops from running `lsof` every
 * 3 seconds for nothing.
 *
 * @module PortDiscovery
 */
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { Context, type Effect } from "effect";

export interface PortDiscoveryShape {
  /** One-shot snapshot of currently listening localhost ports. */
  readonly scan: () => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
  /** Subscribe to changes. Listener invoked on every diff. Returns unsubscribe fn. */
  readonly subscribe: (
    listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  /**
   * Hint that at least one client is interested → starts polling. Returns
   * release fn. When release count hits 0, polling stops.
   */
  readonly retain: () => Effect.Effect<() => void>;
  /** Associate a terminal with its current process family for port attribution. */
  readonly registerTerminalProcesses: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  /** Remove process attribution for a terminal that stopped or closed. */
  readonly unregisterTerminal: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
}

export class PortDiscovery extends Context.Service<PortDiscovery, PortDiscoveryShape>()(
  "t3/preview/Services/PortScanner/PortDiscovery",
) {}

/** Curated list of common dev-server ports for the Windows TCP-probe fallback. */
export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);
