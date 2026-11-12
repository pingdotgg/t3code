import { AppState } from "react-native";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { workspaceConnections } from "../../state/workspace";
import { installDiagnosticRecorder, recordDiagnostic } from "./diagnostic-log";
import { diagnosticAppIdentity, savedDiagnostics } from "./saved-diagnostics";

const connectionDiagnosticsAtom = Atom.make((get) => ({
  type: "connections.changed" as const,
  network: get(environmentCatalog.networkStatusValueAtom),
  connections: get(workspaceConnections.environmentsAtom).map((environment) => ({
    environmentId: String(environment.environmentId),
    state: environment.connectionState,
    enabled: environment.isEnabled,
  })),
})).pipe(Atom.withLabel("mobile:connection-diagnostics"));

export function installMobileDiagnostics() {
  const stopRecording = installDiagnosticRecorder(savedDiagnostics.record);
  recordDiagnostic({ type: "app.started", app: diagnosticAppIdentity() });
  recordDiagnostic({ type: "app.state", state: AppState.currentState ?? "unknown" });
  const appState = AppState.addEventListener("change", (state) =>
    recordDiagnostic({ type: "app.state", state }),
  );
  let lastConnections = "";
  const stopConnections = appAtomRegistry.subscribe(
    connectionDiagnosticsAtom,
    (event) => {
      const next = JSON.stringify(event);
      if (next === lastConnections) return;
      lastConnections = next;
      recordDiagnostic(event);
    },
    { immediate: true },
  );
  return () => {
    appState.remove();
    stopConnections();
    stopRecording();
  };
}
