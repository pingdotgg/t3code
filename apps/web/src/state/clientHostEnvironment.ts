import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { isLoopbackHostname } from "../environments/primary/target";
import { environmentPresentations } from "./presentation";
import { hostEnvironmentIdAtom } from "./primaryEnvironment";

export function isClientHostEnvironment(
  environmentId: EnvironmentId,
  hostEnvironmentId: string | null,
  target: ConnectionTarget | null,
  isDesktopRenderer: boolean,
): boolean {
  if (isDesktopRenderer && environmentId === hostEnvironmentId) return true;
  if (target?._tag !== "PrimaryConnectionTarget") return false;
  if (isDesktopRenderer) return true;
  try {
    return isLoopbackHostname(new URL(target.httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

export const clientHostEnvironmentAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    if (environmentId === null) return false;
    return isClientHostEnvironment(
      environmentId,
      get(hostEnvironmentIdAtom),
      get(environmentPresentations.presentationAtom(environmentId))?.entry.target ?? null,
      window.desktopBridge !== undefined,
    );
  }),
);
