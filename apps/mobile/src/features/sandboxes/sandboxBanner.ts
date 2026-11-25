import { useAtomValue } from "@effect/atom-react";
import { sandboxBannerState } from "@t3tools/client-runtime/sandboxes/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { sandboxEnvironment } from "../../state/sandboxes";
import type { FloatingWorkingStatus } from "../threads/floating-working-status";
import { startSandbox } from "./sandboxActions";

// A primitive per environment, so the thread only re-renders when the status changes.
const bannerStateAtom = Atom.family((environmentId: string) =>
  Atom.make((get): `${"stopped" | "starting"}:${string}` | null => {
    const sandbox = get(sandboxEnvironment.sandboxesAtom).find(
      (candidate) => candidate.environmentId === environmentId,
    );
    const state = sandbox === undefined ? null : sandboxBannerState(sandbox);
    return sandbox === undefined || state === null ? null : `${state}:${sandbox.name}`;
  }).pipe(Atom.withLabel(`mobile:sandboxes:banner:${environmentId}`)),
);

function start(environmentId: EnvironmentId) {
  const sandbox = appAtomRegistry
    .get(sandboxEnvironment.sandboxesAtom)
    .find((candidate) => candidate.environmentId === environmentId);
  if (sandbox !== undefined) void startSandbox(sandbox);
}

/**
 * The thread's connection status for a Sandbox environment, in place of the generic one: a
 * stopped Sandbox is not reconnecting, it needs starting.
 */
export function useSandboxConnectionStatus(
  environmentId: EnvironmentId,
  onReconnect: () => void,
): FloatingWorkingStatus | null {
  const state = useAtomValue(bannerStateAtom(environmentId));
  if (state === null) return null;
  const separator = state.indexOf(":");
  const name = state.slice(separator + 1);
  if (state.startsWith("starting:")) {
    return {
      kind: "connection",
      label: `${name} is starting…`,
      onPress: onReconnect,
    };
  }
  return {
    kind: "connection",
    label: `${name} is stopped`,
    onPress: () => start(environmentId),
    action: {
      label: "Start",
      accessibilityLabel: `Start ${name}`,
      disabled: false,
      onPress: () => start(environmentId),
    },
  };
}
