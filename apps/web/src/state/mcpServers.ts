import { createMcpServerEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp-servers";

import { connectionAtomRuntime } from "../connection/runtime";

export const mcpServersEnvironment = createMcpServerEnvironmentAtoms(connectionAtomRuntime);
