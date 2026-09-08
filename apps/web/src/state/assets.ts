import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@t3tools/client-runtime/state/assets";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  // The session's bootstrap config clears on disconnect and refreshes on reconnect.
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

export const assetEnvironment = createAssetEnvironmentAtoms(
  connectionAtomRuntime,
  localMediaEnvironment,
);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
});
