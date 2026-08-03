/**
 * Web bindings for provider account sign-in (fork f1).
 */
import { createProviderAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-auth";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerAuthEnvironment = createProviderAuthEnvironmentAtoms(connectionAtomRuntime);
