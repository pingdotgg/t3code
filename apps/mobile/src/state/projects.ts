import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { serverEnvironment } from "./server";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
/** The hosts behind every project, as a stable key so readers re-render only when the set changes. */
export const projectHostKindsAtom = Atom.map(environmentProjects.projectsAtom, (projects) =>
  [...new Set(projects.flatMap((project) => project.repositoryIdentity?.provider ?? []))]
    .sort()
    .join(" "),
).pipe(Atom.withLabel("mobile-project-host-kinds"));
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
