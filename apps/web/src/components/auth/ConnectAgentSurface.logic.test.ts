import { expect, it } from "vite-plus/test";
import { RuntimeMode } from "@t3tools/contracts";

import { resolveMcpAccess } from "./ConnectAgentSurface.logic";

it.each(RuntimeMode.literals)("keeps MCP access within the %s policy ceiling", (maxRuntimeMode) => {
  const ceiling = { organization: "Example", maxRuntimeMode };
  expect(resolveMcpAccess("auto", ceiling)).toBe(
    maxRuntimeMode === "full-access" ? "auto" : maxRuntimeMode,
  );
  expect(resolveMcpAccess("read-only", ceiling)).toBe("read-only");
  expect(resolveMcpAccess("approval-required", ceiling)).toBe("approval-required");
});
