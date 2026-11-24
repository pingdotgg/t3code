import type { PinnedPortForward } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import type { PinnedPortForwardState } from "~/state/pinnedPortForwards";

export function pinnedPortLabel(pin: PinnedPortForward, resolve: MessageResolver): string {
  return pin.label ?? resolve(msg("Port {port}", { port: pin.remotePort }));
}

export function pinnedPortMapping(
  environment: string,
  port: number,
  resolve: MessageResolver,
): string {
  const address = `:${port}`;
  return resolve(
    msg("{environment} {port} → This computer {port}", { environment, port: address }),
  );
}

export function pinnedPortStatusText(
  pin: PinnedPortForwardState,
  environment: string,
  resolve: MessageResolver,
): string {
  switch (pin.status) {
    case "waiting":
      return resolve(msg("Waiting for {environment}", { environment }));
    case "starting":
      return resolve(msg("Starting forward…"));
    case "forwarded":
      return resolve(msg("Forwarded"));
    case "port-in-use":
      return resolve(msg("Blocked: local port {port} is in use", { port: pin.remotePort }));
    case "tunnel-disabled":
      return resolve(msg("Blocked: preview tunnel unavailable"));
    case "access-required":
      return resolve(msg("Blocked: terminal access required"));
    case "same-machine":
      return resolve(msg("No forward needed: already on this computer"));
    case "unreachable":
      return resolve(msg("Could not reach the preview tunnel"));
    case "failed":
      return resolve(msg("Could not start the forward"));
  }
}
