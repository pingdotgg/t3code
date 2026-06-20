import type { DesktopBridge, DesktopDiscoveredSshHost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

type DesktopSshDiscoveryBridge = Pick<DesktopBridge, "discoverSshHosts">;

class DesktopSshDiscoveryError extends Schema.TaggedErrorClass<DesktopSshDiscoveryError>()(
  "DesktopSshDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function getDesktopSshDiscoveryBridge(): DesktopSshDiscoveryBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopSshHostsStateAtom(
  getBridge: () => DesktopSshDiscoveryBridge | undefined,
) {
  const discoverDesktopSshHosts = Effect.fn("discoverDesktopSshHosts")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopSshDiscoveryError({
        message: "Desktop SSH host discovery is unavailable.",
      });
    }
    return yield* Effect.tryPromise({
      try: (): Promise<ReadonlyArray<DesktopDiscoveredSshHost>> => bridge.discoverSshHosts(),
      catch: (cause) =>
        new DesktopSshDiscoveryError({
          message: cause instanceof Error ? cause.message : "Failed to discover SSH hosts.",
          cause,
        }),
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
