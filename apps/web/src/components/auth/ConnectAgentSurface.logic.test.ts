import { expect, it } from "vite-plus/test";
import { AuthMcpClientAccess, RuntimeMode } from "@t3tools/contracts";

import { resolveApprovalDecision, resolveMcpAccess } from "./ConnectAgentSurface.logic";

it.each(RuntimeMode.literals)("keeps MCP access within the %s policy ceiling", (maxRuntimeMode) => {
  const ceiling = { organization: "Example", maxRuntimeMode };
  expect(resolveMcpAccess("auto", ceiling)).toBe(
    maxRuntimeMode === "full-access" ? "auto" : maxRuntimeMode,
  );
  expect(resolveMcpAccess("read-only", ceiling)).toBe("read-only");
  expect(resolveMcpAccess("approval-required", ceiling)).toBe("approval-required");
});

it("checks a typed code even in a signed-in browser, and approves without one at Read only", () => {
  const signedOut = {
    clientName: "Poke",
    redirectHost: "poke.com",
    environmentHost: "prod-a1.t3coderelay.com",
  };
  const details = { ...signedOut, csrfToken: "csrf", oneClickAccess: AuthMcpClientAccess.literals };
  const access = resolveMcpAccess(null, undefined);

  // An expired code must fail on the server rather than fall back to this session.
  expect(resolveApprovalDecision({ code: " 7K2P9QXR4MZT ", access, details })).toEqual({
    _tag: "pairing-code",
    access: "read-only",
    code: "7K2P9QXR4MZT",
  });
  expect(resolveApprovalDecision({ code: "auto-q8rz3nwd5ktc", access, details })).toEqual({
    _tag: "pairing-code",
    access: "auto",
    code: "auto-q8rz3nwd5ktc",
  });
  expect(resolveApprovalDecision({ code: "", access, details })).toEqual({
    _tag: "browser-session",
    access: "read-only",
    csrfToken: "csrf",
  });
  expect(resolveApprovalDecision({ code: "", access, details: signedOut })).toBeNull();
});
