import * as Effect from "effect/Effect";
import { NetService } from "@t3tools/shared/Net";

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;

export interface ResolveDesktopBackendPortOptions {
  readonly host: string;
  readonly startPort?: number;
  readonly maxPort?: number;
  readonly canListenOnHost?: (port: number, host: string) => Promise<boolean>;
}

const defaultCanListenOnHost = async (port: number, host: string): Promise<boolean> =>
  Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.canListenOnHost(port, host)),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;

export async function resolveDesktopBackendPort({
  host,
  startPort = DEFAULT_DESKTOP_BACKEND_PORT,
  maxPort = MAX_TCP_PORT,
  canListenOnHost = defaultCanListenOnHost,
}: ResolveDesktopBackendPortOptions): Promise<number> {
  if (!isValidPort(startPort)) {
    throw new Error(`Invalid desktop backend start port: ${startPort}`);
  }

  if (!isValidPort(maxPort)) {
    throw new Error(`Invalid desktop backend max port: ${maxPort}`);
  }

  if (maxPort < startPort) {
    throw new Error(`Desktop backend max port ${maxPort} is below start port ${startPort}`);
  }

  // Keep desktop startup predictable across app restarts by probing upward from
  // the same preferred port instead of picking a fresh ephemeral port.
  for (let port = startPort; port <= maxPort; port += 1) {
    if (await canListenOnHost(port, host)) {
      return port;
    }
  }

  throw new Error(
    `No desktop backend port is available on ${host} between ${startPort} and ${maxPort}`,
  );
}
