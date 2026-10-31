import { createProviderProxyEnvironmentAtoms } from "@t3tools/client-runtime/state/providerProxy";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerProxyEnvironment = createProviderProxyEnvironmentAtoms(connectionAtomRuntime);
