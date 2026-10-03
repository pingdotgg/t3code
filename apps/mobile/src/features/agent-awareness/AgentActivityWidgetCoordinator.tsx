import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { setConnectedAgentActivityWidgetActivities } from "./remoteRegistration";
import { connectedWidgetActivities } from "./widgetSnapshot";

const connectedActivitiesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return null;
  return connectedWidgetActivities(
    new Map(
      Array.from(catalog.entries)
        .filter(([, entry]) => entry.target._tag !== "RelayConnectionTarget")
        .map(([environmentId]) => [
          environmentId,
          get(environmentShell.stateValueAtom(environmentId)),
        ]),
    ),
  );
});

// Keep the existing shell subscriptions observed even when no thread is open.
// iOS persists the last publication when it suspends the app.
export function AgentActivityWidgetCoordinator() {
  const activities = useAtomValue(connectedActivitiesAtom);
  useEffect(() => {
    if (activities !== null) setConnectedAgentActivityWidgetActivities(activities);
  }, [activities]);
  return null;
}
