import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
