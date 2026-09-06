import {
  createManagedRelayQueryManager,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { cloudDebugLog } from "./cloudDebugLog";

const managedRelayAtomRuntime = Atom.runtime(runtimeContextLayer);

const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime, {
  onQueryEvent: (event) =>
    cloudDebugLog(`query:${event.operation}:${event.stage}:${event.phase}`, { ...event }),
});

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshEnvironments(appAtomRegistry, session.accountId);
  }
}
