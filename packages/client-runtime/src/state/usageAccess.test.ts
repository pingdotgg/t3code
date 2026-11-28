import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUsageAccess, unansweredUsageAccessRequests } from "./usageAccess.ts";

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
      session: {
        authenticated: true,
        scopes: [AuthOrchestrationReadScope],
        auth: { serverUpdateScope: "environment:maintain" },
      },
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

describe("unansweredUsageAccessRequests", () => {
  const codex = ProviderInstanceId.make("codex");
  const custom = ProviderInstanceId.make("codex_work");
  const request = (instanceId: ProviderInstanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    provider: "codex" as const,
    paths: [],
  });
  const summary = { accessRequests: [request(codex), request(custom)] };
  const config = (
    providerInstances: Record<string, { driver: string; usageAccess?: "allowed" | "denied" }>,
    providers: ReadonlyArray<{ instanceId: ProviderInstanceId; enabled: boolean }>,
  ) => ({ settings: { providerInstances }, providers }) as unknown as ServerConfig;
  const live = [
    { instanceId: codex, enabled: true },
    { instanceId: custom, enabled: true },
  ];

  it("asks about live agents that have no saved answer", () => {
    expect(
      unansweredUsageAccessRequests({ canAnswer: true, summary, config: config({}, live) }).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([codex, custom]);
  });

  it("drops an agent answered since the summary was scanned", () => {
    const answered = config({ codex: { driver: "codex", usageAccess: "denied" } }, live);
    expect(
      unansweredUsageAccessRequests({ canAnswer: true, summary, config: answered }).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([custom]);
  });

  it("drops an agent removed or turned off since the summary was scanned", () => {
    const changed = config({}, [{ instanceId: codex, enabled: false }]);
    expect(unansweredUsageAccessRequests({ canAnswer: true, summary, config: changed })).toEqual(
      [],
    );
  });

  it("asks nothing before settings load or without permission to save", () => {
    expect(unansweredUsageAccessRequests({ canAnswer: true, summary, config: null })).toEqual([]);
    expect(
      unansweredUsageAccessRequests({ canAnswer: false, summary, config: config({}, live) }),
    ).toEqual([]);
  });
});
