import {
  AuthOrchestrationOperateScope,
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  deriveOrderedProviderSettingsRows,
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

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const unknown = ProviderDriverKind.make("future-driver");

const instance = (driver: ProviderDriverKind, enabled?: boolean): ProviderInstanceConfig => ({
  driver,
  ...(enabled === undefined ? {} : { enabled }),
});

const rowsFor = (input: {
  readonly providerInstances?: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly driverOrder: ReadonlyArray<ProviderDriverKind>;
  readonly providers?: typeof DEFAULT_UNIFIED_SETTINGS.providers;
}) =>
  deriveOrderedProviderSettingsRows({
    settings: {
      providerInstances: (input.providerInstances ?? {}) as Readonly<
        Record<ProviderInstanceId, ProviderInstanceConfig>
      >,
      providers: input.providers ?? DEFAULT_UNIFIED_SETTINGS.providers,
    },
    driverOrder: input.driverOrder,
  });

describe("provider settings row ordering", () => {
  it("uses the supplied known-driver order", () => {
    const rows = rowsFor({
      driverOrder: [claude, codex],
      providerInstances: {
        [defaultInstanceIdForDriver(codex)]: instance(codex),
        [defaultInstanceIdForDriver(claude)]: instance(claude),
      },
    });

    expect(rows.map((row) => row.instanceId)).toEqual(["claudeAgent", "codex"]);
  });

  it("places a default before custom instances of the same driver", () => {
    const rows = rowsFor({
      driverOrder: [codex],
      providerInstances: {
        codex_work: instance(codex),
        codex: instance(codex),
      },
    });

    expect(rows.map((row) => row.instanceId)).toEqual(["codex", "codex_work"]);
  });

  it("retains settings-author order for custom instances", () => {
    const rows = rowsFor({
      driverOrder: [codex],
      providerInstances: {
        codex_second: instance(codex),
        codex_first: instance(codex),
      },
    });

    expect(rows.map((row) => row.instanceId)).toEqual(["codex", "codex_second", "codex_first"]);
  });

  it("appends unknown-driver instances in settings-author order", () => {
    const rows = rowsFor({
      driverOrder: [codex],
      providerInstances: {
        future_second: instance(unknown),
        codex: instance(codex),
        future_first: instance(unknown),
      },
    });

    expect(rows.map((row) => row.instanceId)).toEqual(["codex", "future_second", "future_first"]);
  });

  it("retains disabled provider rows", () => {
    const rows = rowsFor({
      driverOrder: [codex],
      providerInstances: {
        codex_disabled: instance(codex, false),
      },
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        instanceId: "codex_disabled",
        instance: { driver: codex, enabled: false },
      }),
    );
  });

  it("synthesizes a default row from legacy provider settings", () => {
    const rows = rowsFor({ driverOrder: [codex], providerInstances: {} });

    expect(rows).toContainEqual(
      expect.objectContaining({
        instanceId: "codex",
        driver: codex,
        isDefault: true,
        isDirty: false,
        instance: expect.objectContaining({
          driver: codex,
          config: DEFAULT_UNIFIED_SETTINGS.providers.codex,
        }),
      }),
    );
  });
});

describe("provider environment selection", () => {
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
    scopes: [AuthOrchestrationOperateScope],
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

  it("treats a failed session fetch as a transport problem, not a denial", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("granted");
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

  it("grants desktop bridge and remote environments without blocking on the primary session", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });
});

describe("remote operate access", () => {
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
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
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("stays optimistic when the session fetch fails or an older server omits scopes", () => {
    // Transport failures and pre-scope-reporting servers are not permission
    // decisions; the environment RPC layer still rejects unauthorized writes.
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "granted",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
});
