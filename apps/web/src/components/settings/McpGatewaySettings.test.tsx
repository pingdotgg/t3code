// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  McpEnvironmentGrantMatrix,
  McpGatewayOperationalStatus,
  toggleMcpGatewayGrantForAll,
  updateMcpGatewayGrant,
} from "./McpGatewaySettings";
import type { GatewayStatusSnapshot } from "@t3tools/client-runtime/gateway";
import {
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
} from "../../mcpGatewayState";
const grants = {
  "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
  "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
};

const environments = [
  {
    environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
    label: "Primary",
    connectionState: "connected",
  },
  {
    environmentId: "2549ba75-2a91-4554-8baa-88e6ae0efa48",
    label: "JJ’s MacBook",
    connectionState: "connected",
  },
];

describe("MCP environment grant matrix", () => {
  it("preserves explicit lifecycle and control grants when enabling the remaining machines", () => {
    const existing = {
      [environments[0]!.environmentId]: ["read", "control", "lifecycle"] as const,
    };
    const next = toggleMcpGatewayGrantForAll(existing, environments);
    expect(next[environments[0]!.environmentId]).toEqual(existing[environments[0]!.environmentId]);
    expect(next[environments[1]!.environmentId]).toEqual(MCP_GATEWAY_BASELINE_SCOPES);
  });

  it("offers an explicit all-capabilities choice for one environment", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <McpEnvironmentGrantMatrix
            environments={environments}
            grants={grants}
            onChange={onChange}
          />,
        ),
      );
      await act(async () =>
        (container.querySelector('[aria-label="Access for Primary"]') as HTMLElement).click(),
      );
      const all = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent === "All capabilities",
      );
      expect(all).toBeDefined();
      await act(async () => all!.click());
      expect(onChange).toHaveBeenCalledWith({
        ...grants,
        [environments[0]!.environmentId]: MCP_GATEWAY_CONFIGURABLE_SCOPES,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps device transport independent of grants through mixed failures and reconnects", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onChange = vi.fn();
    const mixed = [
      { environmentId: "local", label: "Local", connectionState: "connected" },
      {
        environmentId: "auth",
        label: "Remote auth",
        connectionState: "error",
        failureReason: "authentication" as const,
      },
      {
        environmentId: "schema",
        label: "Remote schema",
        connectionState: "error",
        failureReason: "unsupported" as const,
      },
      {
        environmentId: "socket",
        label: "Remote socket",
        connectionState: "reconnecting",
        failureReason: "transport" as const,
      },
      { environmentId: "pending", label: "Pending", connectionState: "connecting" },
    ];
    try {
      await act(async () =>
        root.render(
          <McpEnvironmentGrantMatrix
            environments={mixed}
            grants={{ auth: ["read"], schema: ["read"], removed: ["read"] }}
            onChange={onChange}
          />,
        ),
      );
      expect(container.textContent).toContain("1 of 5 registered devices connected");
      expect(container.textContent).toContain("Authentication failed");
      expect(container.textContent).toContain("Incompatible connection");
      expect(container.textContent).toContain("Transport failed");
      expect(container.textContent).toContain("Connecting");
      expect(container.textContent).toContain("Unavailable");
      expect(container.querySelector('[aria-label="Access for Local"]')?.textContent).toContain(
        "Access off",
      );
      expect(
        container.querySelector('[aria-label="Access for Remote auth"]')?.textContent,
      ).toContain("Access on");
      await act(async () =>
        root.render(
          <McpEnvironmentGrantMatrix
            environments={mixed.map((e) => ({
              ...e,
              connectionState: "connected",
              failureReason: undefined,
            }))}
            grants={{}}
            onChange={onChange}
          />,
        ),
      );
      expect(container.textContent).toContain("5 of 5 registered devices connected");
      expect(container.textContent).not.toContain("Authentication failed");
      expect(container.textContent).toContain("Access off");
      await act(async () =>
        root.render(
          <McpEnvironmentGrantMatrix
            environments={mixed.map((e) => ({
              ...e,
              connectionState: "offline",
              failureReason: undefined,
            }))}
            grants={{ auth: ["read"] }}
            onChange={onChange}
          />,
        ),
      );
      expect(container.textContent).toContain("0 of 5 registered devices connected");
      expect(container.textContent).toContain("Disconnected");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("offers all v3 capabilities while keeping ordinary enable and select-all least privilege", () => {
    expect(MCP_GATEWAY_CONFIGURABLE_SCOPES).toEqual([
      "read",
      "create",
      "send",
      "control",
      "lifecycle",
      "approval",
      "artifact",
      "review",
      "admin",
      "delivery",
    ]);
    expect(MCP_GATEWAY_BASELINE_SCOPES).toEqual(["read", "create", "send"]);
    expect(toggleMcpGatewayGrantForAll({}, environments)[environments[0]!.environmentId]).toEqual([
      "read",
      "create",
      "send",
    ]);
    expect(updateMcpGatewayGrant({}, environments[0]!.environmentId, "admin", true)).toEqual({
      [environments[0]!.environmentId]: ["admin"],
    });
  });

  it("updates scopes by exact registry id without changing other environment grants", () => {
    expect(
      updateMcpGatewayGrant(grants, "2549ba75-2a91-4554-8baa-88e6ae0efa48", "send", true),
    ).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read", "send"],
    });
    expect(
      updateMcpGatewayGrant(
        { "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] },
        "2549ba75-2a91-4554-8baa-88e6ae0efa48",
        "read",
        false,
      ),
    ).toEqual({});
  });

  it("select all turns every visible machine on, then back off", () => {
    const once = toggleMcpGatewayGrantForAll({}, environments);
    expect(once[environments[0]!.environmentId]).toEqual(["read", "create", "send"]);
    expect(once[environments[1]!.environmentId]).toEqual(["read", "create", "send"]);
    const twice = toggleMcpGatewayGrantForAll(once, environments);
    expect(twice).toEqual({});
  });

  it("select all is safe on an empty machine list", () => {
    expect(toggleMcpGatewayGrantForAll({ "gone-env": ["read"] }, [])).toEqual({
      "gone-env": ["read"],
    });
  });

  it("select all does not grant machines outside the visible list", () => {
    const hidden = { "hidden-env": ["read"] as const };
    const partial = { [environments[0]!.environmentId]: ["read"] as const, ...hidden };
    const next = toggleMcpGatewayGrantForAll(partial, environments);
    expect(next["hidden-env"]).toEqual(["read"]);
    expect(next[environments[0]!.environmentId]).toContain("read");
  });

  it("renders machine rows with select all, per-machine dropdown, and no checkbox pile", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={environments}
        grants={{ [environments[0]!.environmentId]: ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Primary");
    expect(markup).toContain("a534b83f-a352-44d8-aedc-c4230c179390");
    expect(markup).toContain("JJ’s MacBook");
    expect(markup).toContain("Enable all environments");
    expect(markup).toContain("Mixed selection");
    expect(markup).toContain('aria-label="Access for Primary"');
    expect(markup).toContain('aria-label="Access for JJ’s MacBook"');
    // No per-scope checkbox pile.
    expect(markup).not.toContain("Grant read access to Primary");
  });

  it("renders an all-on selection without an indeterminate marker", () => {
    const full = {
      [environments[0]!.environmentId]: ["read"] as const,
      [environments[1]!.environmentId]: ["read"] as const,
    };
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix environments={environments} grants={full} onChange={vi.fn()} />,
    );
    expect(markup).toContain("Access on for all listed machines");
  });

  it("keeps persisted grants for unregistered environments visible and revocable", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={[]}
        grants={{ "removed-environment": ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Unavailable environment");
    expect(markup).toContain("removed-environment");
    expect(markup).toContain('aria-label="Access for Unavailable environment"');
    expect(markup).toContain('aria-checked="true"');
  });
});

describe("MCP gateway operational status", () => {
  const base: GatewayStatusSnapshot = {
    schemaVersion: "3",
    capturedAt: "2026-09-05T00:00:00.000Z",
    live: true,
    stale: false,
    retention: { maxEventsPerEnvironment: 100_000, maxAgeDays: 7 },
    environments: [],
  };

  it("does not mistake a live event store for connected devices or retain revoked read access", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const snapshot = {
      ...base,
      environments: [
        {
          environmentId: "remote",
          latestSequence: 41,
          retainedEventCount: 3,
          oldestRetainedSequence: 39,
          deliveryAccess: false,
        },
      ],
    };
    const rows = [{ environmentId: "remote", label: "Remote", connectionState: "offline" }];
    const render = async (
      state: "running" | "degraded" | "connecting",
      currentGrants: Record<string, readonly "read"[]>,
    ) => {
      await act(async () =>
        root.render(
          <McpGatewayOperationalStatus
            state={state}
            snapshot={snapshot}
            environments={rows}
            grants={currentGrants}
            onRefresh={vi.fn()}
          />,
        ),
      );
    };
    try {
      await render("running", { remote: ["read"] });
      expect(container.textContent).toContain("Local gateway bridge: Connected");
      expect(container.textContent).toContain("Device: Disconnected");
      expect(container.textContent).toContain("Event store as of");
      expect(container.textContent).toContain("does not indicate device connectivity");
      expect(container.textContent).toContain("Cursor 41");
      await render("connecting", { remote: ["read"] });
      expect(container.textContent).toContain("Local gateway bridge: Connecting");
      expect(container.textContent).not.toContain("Cursor 41");
      await render("degraded", { remote: ["read"] });
      expect(container.textContent).toContain("Local gateway bridge: Disconnected");
      expect(container.textContent).not.toContain("Cursor 41");
      await render("running", {});
      expect(container.textContent).not.toContain("Cursor 41");
      expect(container.textContent).toContain("No readable environments");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("renders truthful sidecar values and safe delivery inventory", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onRefresh = vi.fn();
    const snapshot: GatewayStatusSnapshot = {
      ...base,
      environments: [
        {
          environmentId: "env-safe",
          latestSequence: 41,
          oldestRetainedSequence: 7,
          retainedEventCount: 35,
          deliveryAccess: true,
          subscriptionCount: 1,
          subscriptions: [
            {
              subscriptionId: "sub-safe",
              ackedSequence: 40,
              pendingEventCount: 1,
              status: "active",
            },
          ],
          webhookCount: 1,
          webhooks: [
            {
              webhookId: "whk-safe",
              ackedSequence: 39,
              status: "degraded",
              deliveries: { pending: 1, inFlight: 0, acked: 4, failed: 2 },
            },
          ],
          deliveries: { pending: 1, inFlight: 0, acked: 4, failed: 2 },
          deliveryFailureCount: 2,
        },
      ],
    };
    await act(async () => {
      root.render(
        <McpGatewayOperationalStatus
          state="running"
          snapshot={snapshot}
          labels={{ "env-safe": "Disposable fixture" }}
          grants={{ "env-safe": ["read", "delivery"] }}
          onRefresh={onRefresh}
        />,
      );
    });
    expect(container.textContent).toContain("Cursor 41; retained 35; oldest 7");
    expect(container.textContent).toContain("sub-safe — active; cursor 40; 1 pending");
    expect(container.textContent).toContain("whk-safe — degraded; cursor 39; 1 pending, 2 failed");
    expect(container.textContent).not.toContain("http");
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(onRefresh).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("shows disconnected, loading, stale, empty, and permission-needed states", () => {
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="degraded" snapshot={null} onRefresh={vi.fn()} />,
      ),
    ).toContain("disconnected or degraded");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="connecting" snapshot={null} onRefresh={vi.fn()} />,
      ),
    ).toContain("Loading operational status");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus
          state="running"
          snapshot={{ ...base, stale: true }}
          onRefresh={vi.fn()}
        />,
      ),
    ).toContain("Status is stale");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="running" snapshot={base} onRefresh={vi.fn()} />,
      ),
    ).toContain("No readable environments");
    const readOnly = {
      ...base,
      environments: [
        {
          environmentId: "read-only",
          latestSequence: 0,
          oldestRetainedSequence: null,
          retainedEventCount: 0,
          deliveryAccess: false,
        },
      ],
    } satisfies GatewayStatusSnapshot;
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus
          state="running"
          snapshot={readOnly}
          grants={{ "read-only": ["read"] }}
          onRefresh={vi.fn()}
        />,
      ),
    ).toContain("Delivery permission needed");
  });
});
