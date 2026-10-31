import { useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  AuthTerminalReadScope,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  desktopUpdateInstallNeedsConfirmation,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopHostedEnvironmentIdle,
} from "../components/desktopUpdate.logic";
import { environmentCatalog } from "../connection/catalog";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { ensureLocalApi } from "../localApi";
import { environmentSession, sessionHasScope } from "./session";
import { environmentShell } from "./shell";
import { terminalEnvironment } from "./terminal";
import { environmentThreadShells } from "./threads";

let previousIdleBackendIds: ReadonlyArray<string> = [];
/** Backend ids of the environments this desktop app runs, or null unless every one is known idle. */
const idleDesktopBackendIdsAtom = Atom.make((get): ReadonlyArray<string> | null => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return null;
  const idle: string[] = [];
  for (const [environmentId, entry] of catalog.entries) {
    const backendId =
      entry.target._tag === "PrimaryConnectionTarget"
        ? PRIMARY_LOCAL_ENVIRONMENT_ID
        : desktopLocalBackendId(entry.target);
    if (backendId === null) continue;
    const shellLive = get(environmentShell.statusAtom(environmentId)) === "live";
    const canReadTerminals = sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthTerminalReadScope,
    );
    const terminals =
      shellLive && canReadTerminals
        ? AsyncResult.getOrElse(
            get(terminalEnvironment.metadata({ environmentId, input: null })),
            () => null,
          )
        : null;
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    if (!isDesktopHostedEnvironmentIdle({ shellLive, threads, terminals })) return null;
    idle.push(backendId);
  }
  idle.sort();
  if (arrayElementsEqual(previousIdleBackendIds, idle)) return previousIdleBackendIds;
  previousIdleBackendIds = idle;
  return idle;
}).pipe(Atom.withLabel("web-desktop-idle-backend-ids"));

const NO_IDLE_BACKENDS_ATOM = Atom.make<ReadonlyArray<string> | null>(null).pipe(
  Atom.withLabel("web-desktop-idle-backend-ids:none"),
);

function readRunningBackendIds(): ReadonlyArray<string> | null {
  try {
    return window.desktopBridge?.getLocalEnvironmentBootstraps().map(({ id }) => id) ?? null;
  } catch {
    return null;
  }
}

/** Confirms a desktop update install, skipping the prompt only when nothing it stops is working. */
export function useConfirmDesktopUpdateInstall(installable: boolean) {
  // Watched only while an install is offered, so its terminal lists have loaded by the click.
  const idleBackendIds = useAtomValue(
    installable ? idleDesktopBackendIdsAtom : NO_IDLE_BACKENDS_ATOM,
  );
  return async (
    state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  ): Promise<boolean> =>
    !desktopUpdateInstallNeedsConfirmation(idleBackendIds, readRunningBackendIds()) ||
    ensureLocalApi().dialogs.confirm(getDesktopUpdateInstallConfirmationMessage(state));
}
