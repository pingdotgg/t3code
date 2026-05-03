/**
 * PreviewPortScanner - Discovers listening localhost ports for the preview
 * empty-state recommendations.
 *
 * Reference-counted polling: the scanner only runs when at least one client
 * has called `retain()`. This keeps idle desktops from running `lsof` every
 * 3 seconds for nothing.
 *
 * @module PreviewPortScanner
 */
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { Context, type Effect } from "effect";

export interface PreviewPortScannerShape {
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
}

export class PreviewPortScanner extends Context.Service<
  PreviewPortScanner,
  PreviewPortScannerShape
>()("t3/preview/Services/PortScanner") {}

/** Curated list of common dev-server ports for the Windows TCP-probe fallback. */
export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);
