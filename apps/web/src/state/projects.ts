import {
  createEnvironmentProjectAtoms,
  createProjectEnvironmentAtoms,
} from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  catalogHasPrimaryEntry,
  environmentShell,
  environmentSnapshotAtom,
  expectsPrimaryEnvironment,
  isConnectionSettledOffline,
} from "./shell";
import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { serverEnvironment } from "./server";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const defaultProjectFallbackReadyAtom = Atom.family((projectKey: string | null) =>
  Atom.make((get) => {
    const remembered = projectKey === null ? null : parseScopedProjectKey(projectKey);
    if (!remembered) return true;
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return false;
    if (expectsPrimaryEnvironment() && !catalogHasPrimaryEntry(catalog)) return false;
    const entry = catalog.entries.get(remembered.environmentId);
    if (!entry?.enabled || entry.unsupportedReason !== undefined) return true;
    if (get(environmentShell.statusAtom(remembered.environmentId)) === "live") return true;
    return isConnectionSettledOffline(
      AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(remembered.environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      ),
    );
  }).pipe(Atom.withLabel(`web-default-project-fallback-ready:${projectKey}`)),
);
