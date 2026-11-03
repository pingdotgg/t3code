import { createWorkspaceRepositoryEnvironmentAtoms } from "@t3tools/client-runtime/state/workspaceRepositories";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";

export const workspaceRepositoryEnvironment = createWorkspaceRepositoryEnvironmentAtoms(
  connectionAtomRuntime,
  { projectAtom: environmentProjects.projectAtom },
);
