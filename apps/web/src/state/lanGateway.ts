import { createLanGatewayEnvironmentAtoms } from "@t3tools/client-runtime/state/lanGateway";

import { connectionAtomRuntime } from "../connection/runtime";

export const lanGatewayEnvironment = createLanGatewayEnvironmentAtoms(connectionAtomRuntime);
