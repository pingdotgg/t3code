import type { DesktopBridge, DesktopDiscoveredSshHost } from "@t3tools/contracts";
import { searchItems } from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

type DesktopSshDiscoveryBridge = Pick<DesktopBridge, "discoverSshHosts">;

export function filterDiscoveredSshHosts(
  hosts: ReadonlyArray<DesktopDiscoveredSshHost>,
  query: string,
): ReadonlyArray<DesktopDiscoveredSshHost> {
  return searchItems(hosts, query, (host) => [host.alias]);
}

class DesktopSshDiscoveryUnavailableError extends Schema.TaggedError<DesktopSshDiscoveryUnavailableError>()(
  "DesktopSshDiscoveryUnavailableError",
  {},
) {
  override get message(): string {
    return m(msg("Desktop SSH host discovery is unavailable."));
  }
}

class DesktopSshDiscoveryError extends Schema.TaggedError<DesktopSshDiscoveryError>()(
  "DesktopSshDiscoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return m(msg("Failed to discover SSH hosts."));
  }
}

function getDesktopSshDiscoveryBridge(): DesktopSshDiscoveryBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function createDesktopSshHostsStateAtom(getBridge: () => DesktopSshDiscoveryBridge | undefined) {
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
