import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@t3tools/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { environmentSession } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
});
