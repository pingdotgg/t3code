import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  primary: null as string | null,
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: "connected" | "offline" };
    serverConfig: { environment: { capabilities: { linear: boolean } } };
  }>,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./LinearControls", () => ({
  LinearMessage: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  LinearSelect: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("./LinearWorkspace", () => ({
  LinearWorkspace: ({ environmentId }: { environmentId: string }) => (
    <div>Workspace for {environmentId}</div>
  ),
}));

import { LinearPage } from "./LinearPage";

function environment(id: string, linear = true, connected = true) {
  return {
    environmentId: id,
    label: id,
    connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
    serverConfig: { environment: { capabilities: { linear } } },
  };
}

beforeEach(() => {
  state.primary = null;
  state.environments = [];
});

it("opens a connected remote workspace when the local environment is disabled", () => {
  state.environments = [environment("saved-remote")];
  const html = renderToStaticMarkup(<LinearPage />);
  expect(html).toContain("Workspace for saved-remote");
  expect(html).not.toContain("Connect an environment");
});

it("opens a capable remote instead of an unsupported primary and keeps selection reachable", () => {
  state.primary = "local";
  state.environments = [environment("local", false), environment("saved-remote")];
  const html = renderToStaticMarkup(<LinearPage />);
  expect(html).toContain("Workspace for saved-remote");
  expect(html).toContain("Environment</button>");
});

it("prefers a connected capable environment over an offline saved server", () => {
  state.environments = [environment("offline", true, false), environment("connected")];
  expect(renderToStaticMarkup(<LinearPage />)).toContain("Workspace for connected");
});

it("keeps environment selection reachable when every server needs updating", () => {
  state.environments = [environment("first", false), environment("second", false)];
  const html = renderToStaticMarkup(<LinearPage />);
  expect(html).toContain("Update this environment");
  expect(html).toContain("Environment</button>");
});
