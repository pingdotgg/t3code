import { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentShell } from "../../state/shell";
import { projectEnvironment } from "../../state/projects";
import {
  resolveWorkspaceReadTarget,
  workspaceReadHostOptions,
  type WorkspaceReadDependencies,
} from "./workspaceRead";

/** Uses the selected environment's authenticated connection, never a global current-project cwd. */
export const appWorkspaceRead: WorkspaceReadDependencies = {
  resolve(context) {
    const state = appAtomRegistry.get(
      environmentShell.stateValueAtom(EnvironmentId.make(context.resource.environmentId)),
    );
    if (state.status !== "live" || Option.isNone(state.snapshot))
      throw new Error("Workspace environment is not live");
    return resolveWorkspaceReadTarget(state.snapshot.value, context);
  },
  async read(environmentId, input, signal) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFile({ environmentId: EnvironmentId.make(environmentId), input }),
      { refresh: true, signal },
    );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  },
};

export function createAppWorkspaceReadHostOptions(
  grant: Parameters<typeof workspaceReadHostOptions>[1],
) {
  return workspaceReadHostOptions(appWorkspaceRead, grant);
}
