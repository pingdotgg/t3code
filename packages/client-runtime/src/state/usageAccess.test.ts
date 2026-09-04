import { AuthDiagnosticsReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUsageAccess } from "./usageAccess.ts";

describe("resolveUsageAccess", () => {
  it.each(["available", "offline", "error"] as const)(
    "reports %s connections without a session instead of keeping totals pending",
    (connectionPhase) => {
      expect(
        resolveUsageAccess({ connectionPhase, session: null, hasSessionError: false }),
      ).toEqual({
        canReadDiagnostics: false,
        isPending: false,
        error: "This environment is not connected.",
      });
    },
  );

  it.each(["connecting", "reconnecting", "connected"] as const)(
    "waits for a session check while %s",
    (connectionPhase) => {
      expect(
        resolveUsageAccess({ connectionPhase, session: null, hasSessionError: false }),
      ).toEqual({ canReadDiagnostics: false, isPending: true, error: null });
    },
  );

  it("preserves a known grant so disconnected usage can retain its cached summary", () => {
    expect(
      resolveUsageAccess({
        connectionPhase: "offline",
        session: { authenticated: true, scopes: [AuthDiagnosticsReadScope] },
        hasSessionError: false,
      }),
    ).toEqual({ canReadDiagnostics: true, isPending: false, error: null });
  });

  it("distinguishes a failed check from a resolved grant without diagnostics access", () => {
    const denied = resolveUsageAccess({
      connectionPhase: "connected",
      session: { authenticated: true, scopes: [AuthOrchestrationReadScope] },
      hasSessionError: false,
    });
    const failed = resolveUsageAccess({
      connectionPhase: "connected",
      session: null,
      hasSessionError: true,
    });

    expect(denied).toEqual({
      canReadDiagnostics: false,
      isPending: false,
      error: "This connection does not have access to diagnostics and usage.",
    });
    expect(failed).toEqual({
      canReadDiagnostics: false,
      isPending: false,
      error: "Could not check this connection's access to diagnostics and usage.",
    });
  });
});
