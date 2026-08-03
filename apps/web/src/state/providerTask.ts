/**
 * Web bindings for the per-task stop command (fork f3).
 */
import { createProviderTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-task";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerTaskEnvironment = createProviderTaskEnvironmentAtoms(connectionAtomRuntime);
