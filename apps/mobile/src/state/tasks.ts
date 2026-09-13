import {
  createEnvironmentTaskAtoms,
  createTaskEnvironmentAtoms,
} from "@t3tools/client-runtime/state/tasks";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const taskEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);
export const environmentTasks = createEnvironmentTaskAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
