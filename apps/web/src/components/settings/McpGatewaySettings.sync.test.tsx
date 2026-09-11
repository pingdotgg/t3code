import { act, type ReactNode } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { McpGatewaySettings } from "./McpGatewaySettings";
import { MCP_GATEWAY_GRANTS_KEY, MCP_GATEWAY_ENABLED_KEY } from "../../mcpGatewayState";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => undefined,
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => [],
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));

vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

it("refreshes visible gateway access when another window changes saved settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  const events = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(events, {
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      sessionStorage: { getItem: () => "" },
      desktopBridge: { getMcpGatewayLaunchConfig: () => ({ command: "t3", args: [], env: {} }) },
    }),
  );
  const renderer = await act(async () => create(<McpGatewaySettings />));
  try {
    expect(JSON.stringify(renderer.toJSON())).toContain("No registered environments.");
    await act(async () => {
      values.set(MCP_GATEWAY_GRANTS_KEY, JSON.stringify({ remote: ["read"] }));
      values.set(MCP_GATEWAY_ENABLED_KEY, "true");
      events.dispatchEvent(Object.assign(new Event("storage"), { key: MCP_GATEWAY_GRANTS_KEY }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Unavailable environment");
    expect(JSON.stringify(renderer.toJSON())).toContain("Read environments and threads");
    await act(async () => {
      values.clear();
      events.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("No registered environments.");
  } finally {
    await act(async () => renderer.unmount());
  }
});

it("keeps the gateway disabled when saving its enabled state fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(events, {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("Storage denied");
        },
      },
      sessionStorage: { getItem: () => "", setItem: () => undefined },
    }),
  );
  const renderer = await act(async () => create(<McpGatewaySettings />));
  try {
    const toggle = renderer.root.findAll(
      (node) =>
        node.props["aria-label"] === "Enable MCP Gateway" &&
        typeof node.props.onCheckedChange === "function",
    )[0]!;
    await act(async () => toggle.props.onCheckedChange(true));
    expect(toggle.props.checked).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain("Gateway settings could not be saved");
  } finally {
    await act(async () => renderer.unmount());
  }
});
