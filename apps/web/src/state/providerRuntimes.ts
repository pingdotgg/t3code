import { createProviderRuntimeEnvironmentAtoms } from "@t3tools/client-runtime/state/providerRuntimes";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerRuntimeEnvironment =
  createProviderRuntimeEnvironmentAtoms(connectionAtomRuntime);
