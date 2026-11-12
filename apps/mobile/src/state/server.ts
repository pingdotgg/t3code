import { Atom, AsyncResult } from "effect/reactivity";
import type { EnvironmentId, ThreadFolderListResult } from "@t3tools/contracts";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
  providerCatalogsOnDemand: true,
});
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});


const environmentThreadFoldersAtom = Atom.family((environmentId: EnvironmentId) => {
  let previousList: ThreadFolderListResult | null = null;
  let previous: ReadonlyArray<EnvironmentThreadFolder> = [];
  return Atom.make((get) => {
    const result = get(serverEnvironment.threadFoldersLive({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(result) || result.value === previousList) return previous;
    previousList = result.value;
    previous = result.value.folders.map((folder) => ({ ...folder, environmentId }));
    return previous;
  });
});

export const threadFoldersAtom = (() => {
  let previous: ReadonlyArray<EnvironmentThreadFolder> = [];
  return Atom.make((get) => {
    const next = [...get(environmentServerConfigsAtom)].flatMap(
      ([environmentId, config]) => config.environment.capabilities.threadFolders === true
        ? get(environmentThreadFoldersAtom(environmentId)) : [],
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  });
})();
