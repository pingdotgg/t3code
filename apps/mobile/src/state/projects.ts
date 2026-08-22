import { selectProjectFaviconSources } from "@t3tools/client-runtime/state/project-favicon";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export const projectFaviconSourcesAtom = Atom.make((get) =>
  selectProjectFaviconSources(get(environmentProjects.projectsAtom)),
).pipe(Atom.withLabel("mobile-project-favicon-sources"));
