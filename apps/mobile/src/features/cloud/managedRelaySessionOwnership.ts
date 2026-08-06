import {
  type ManagedRelaySessionInput,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export type ManagedRelaySessionOwner = "ui" | "background";

interface OwnerLease extends ManagedRelaySessionInput {
  readonly id: number;
}

export interface ManagedRelaySessionOwnership {
  readonly setOwner: (
    owner: ManagedRelaySessionOwner,
    session: ManagedRelaySessionInput,
  ) => (() => void) | null;
  readonly releaseOwner: (owner: ManagedRelaySessionOwner) => void;
  readonly clear: () => void;
}

export function createManagedRelaySessionOwnership(
  registry: AtomRegistry.AtomRegistry,
): ManagedRelaySessionOwnership {
  let nextLeaseId = 0;
  let ui: OwnerLease | null = null;
  let background: OwnerLease | null = null;
  let appliedLeaseId: number | null = null;

  const applyEffectiveOwner = () => {
    const effective = ui ?? background;
    const effectiveLeaseId = effective?.id ?? null;
    if (effectiveLeaseId === appliedLeaseId) {
      return;
    }
    appliedLeaseId = effectiveLeaseId;
    setManagedRelaySession(registry, effective);
  };

  const releaseLease = (owner: ManagedRelaySessionOwner, leaseId: number) => {
    if (owner === "ui") {
      if (ui?.id !== leaseId) {
        return;
      }
      ui = null;
    } else {
      if (background?.id !== leaseId) {
        return;
      }
      background = null;
    }
    applyEffectiveOwner();
  };

  return {
    setOwner(owner, session) {
      const lease: OwnerLease = { ...session, id: ++nextLeaseId };
      if (owner === "ui") {
        ui = lease;
        if (background?.accountId !== session.accountId) {
          background = null;
        }
      } else {
        // A headless bootstrap may finish after the user switches accounts in
        // the UI. Never retain that stale result for a later UI unmount.
        if (ui && ui.accountId !== session.accountId) {
          return null;
        }
        background = lease;
      }
      applyEffectiveOwner();
      return () => releaseLease(owner, lease.id);
    },
    releaseOwner(owner) {
      if (owner === "ui") {
        ui = null;
      } else {
        background = null;
      }
      applyEffectiveOwner();
    },
    clear() {
      ui = null;
      background = null;
      applyEffectiveOwner();
    },
  };
}

export const managedRelaySessionOwnership = createManagedRelaySessionOwnership(appAtomRegistry);

export function acquireBackgroundManagedRelaySession(
  session: ManagedRelaySessionInput,
): (() => void) | null {
  return managedRelaySessionOwnership.setOwner("background", session);
}
