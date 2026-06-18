import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
