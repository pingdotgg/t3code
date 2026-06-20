import type { DesktopBridge, DesktopDiscoveredSshHost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

type DesktopSshDiscoveryBridge = Pick<DesktopBridge, "discoverSshHosts">;

class DesktopSshDiscoveryUnavailableError extends Schema.TaggedErrorClass<DesktopSshDiscoveryUnavailableError>()(
  "DesktopSshDiscoveryUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop SSH host discovery is unavailable.";
  }
}

class DesktopSshDiscoveryError extends Schema.TaggedErrorClass<DesktopSshDiscoveryError>()(
  "DesktopSshDiscoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to discover SSH hosts.";
  }
}

function getDesktopSshDiscoveryBridge(): DesktopSshDiscoveryBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopSshHostsStateAtom(
  getBridge: () => DesktopSshDiscoveryBridge | undefined,
) {
  const discoverDesktopSshHosts = Effect.fn("discoverDesktopSshHosts")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopSshDiscoveryUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<ReadonlyArray<DesktopDiscoveredSshHost>> => bridge.discoverSshHosts(),
      catch: (cause) => new DesktopSshDiscoveryError({ cause }),
    });
  });

  return Atom.make(discoverDesktopSshHosts()).pipe(
    Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
    Atom.keepAlive,
    Atom.withLabel("desktop:ssh-hosts"),
  );
}

export const desktopSshHostsStateAtom = createDesktopSshHostsStateAtom(
  getDesktopSshDiscoveryBridge,
);
