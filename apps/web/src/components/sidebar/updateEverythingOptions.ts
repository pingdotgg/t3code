import { Atom } from "effect/reactivity";
import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { environmentPresentations } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentSession } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { canUpdateServer } from "../ServerUpdateAction";
import type { UpdateOptionMachine } from "./updateEverything.logic";

export const updateOptionsSnapshotAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const machines: UpdateOptionMachine[] = [...presentations.entries()].map(
    ([environmentId, presentation]) => {
      const session = get(environmentSession.sessionStateAtom(environmentId));
      return {
        environmentId,
        label: presentation.entry.target.label,
        serverConfig: presentation.serverConfig,
        connected: presentation.connection.phase === "connected",
        connectionPhase: presentation.connection.phase,
        enabled: presentation.entry.enabled,
        sessionReady: session._tag === "Success" && session.value.authenticated,
        sessionInitialized: session._tag !== "Initial",
        hostedByThisApp:
          isElectron &&
          (presentation.entry.target._tag === "PrimaryConnectionTarget" ||
            isDesktopLocalConnectionTarget(presentation.entry.target)),
        canMaintain: canUpdateServer(session),
        canManageProviders: get(serverEnvironment.updateProvider.permissionAtom(environmentId)),
        providers: get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
        updateState: get(serverEnvironment.updateStateAtom(environmentId)),
      };
    },
  );
  return {
    ready: catalog.isReady,
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
    localEnvironmentDisabled: isLocalEnvironmentDisabled(),
    canDisableLocalAutoResume:
      window.desktopBridge?.supportsUpdateThreadContinuationControl === true,
    machines,
  };
}).pipe(Atom.withLabel("update-options-snapshot"));
