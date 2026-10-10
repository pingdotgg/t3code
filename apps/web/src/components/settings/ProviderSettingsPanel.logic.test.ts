import {
  AuthProvidersManageScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceEnablementOverridePatch,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("provider environment selection", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: true,
      }),
    ).toBe(true);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "reconnecting",
        hasServerConfig: true,
      }),
    ).toBe(false);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: false,
      }),
    ).toBe(false);
  });

  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildProviderEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildProviderEnvironmentOptions(environments, primaryId);

    expect(resolveSelectedProviderEnvironmentId(options, sshId, primaryId)).toBe(sshId);
    expect(
      resolveSelectedProviderEnvironmentId(
        options.filter((environment) => environment.environmentId !== sshId),
        sshId,
        primaryId,
      ),
    ).toBe(primaryId);
    expect(resolveSelectedProviderEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(
      relayId,
    );
    expect(resolveSelectedProviderEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("provider environment access", () => {
  it("allows connected environments with config and operate access", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "editable" });
  });

  it("waits for config before exposing controls", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "loading", reason: "config" });
  });

  it("waits for unresolved operate access instead of assuming it is editable", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "pending",
      }),
    ).toEqual({ kind: "loading", reason: "permissions" });
  });

  it("represents known missing operate access as read only", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "denied",
      }),
    ).toEqual({ kind: "read-only" });
  });

  it.each(["available", "offline", "connecting", "reconnecting"] as const)(
    "keeps %s environments unavailable",
    (connectionPhase) => {
      expect(
        classifyProviderEnvironmentAccess({
          connectionPhase,
          hasServerConfig: true,
          operateAccess: "granted",
        }),
      ).toEqual({ kind: "unavailable" });
    },
  );

  it("separates connection errors from other unavailable states", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "error",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("primary operate access", () => {
  const authenticated = {
    authenticated: true as const,
    scopes: [AuthProvidersManageScope],
  };

  it("keeps cached session data authoritative while SWR revalidates", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: authenticated,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("reports pending only before any session has resolved", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });

  it("denies writes when the session fetch fails", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("denied");
  });

  it("denies unauthenticated sessions and sessions without the operate scope", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("waits for explicit grants on desktop and remote environments", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });
});

describe("buildProviderInstanceEnablementOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");
  const otherInstanceId = ProviderInstanceId.make("claudeAgent_personal");

  it("sets an override when the project has none yet", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {},
    };

    expect(
      buildProviderInstanceEnablementOverridePatch(settings, projectId, instanceId, true),
    ).toEqual({ [projectId]: { providerInstanceEnablement: { [instanceId]: true } } });
  });

  it("adds an instance override alongside the project's other overrides", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstanceEnablement: { [otherInstanceId]: false },
        },
      },
    };

    expect(
      buildProviderInstanceEnablementOverridePatch(settings, projectId, instanceId, true),
    ).toEqual({
      [projectId]: {
        newWorktreesStartFromOrigin: true,
        providerInstanceEnablement: { [otherInstanceId]: false, [instanceId]: true },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstanceEnablement: { [instanceId]: true } },
      },
    };

    expect(
      buildProviderInstanceEnablementOverridePatch(settings, projectId, instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("resets one instance while another instance's override and other keys survive", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstanceEnablement: { [instanceId]: true, [otherInstanceId]: false },
        },
      },
    };

    expect(
      buildProviderInstanceEnablementOverridePatch(settings, projectId, instanceId, undefined),
    ).toEqual({
      [projectId]: {
        newWorktreesStartFromOrigin: true,
        providerInstanceEnablement: { [otherInstanceId]: false },
      },
    });
  });
});

describe("remote operate access", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveRemoteOperateAccess({
        session: {
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("reports pending before the first session resolve, then keeps cached data", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("denies writes when the session fetch fails or scopes are missing", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "denied",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});
