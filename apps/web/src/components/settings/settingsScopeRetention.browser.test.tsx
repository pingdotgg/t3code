import { act, render } from "../../../test/render";
import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import type { SettingsScopeSearch } from "./settingsScope";

interface ScopeState {
  readonly search: SettingsScopeSearch;
  readonly environmentId: string | null;
}

const state = vi.hoisted(() => ({
  pathname: "/settings/diagnostics",
  scope: { search: {}, environmentId: null } as ScopeState,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  createFileRoute: (() => (options: { component: () => ReactNode }) => ({
    options,
    useSearch: () => state.scope.search,
    useNavigate: () => vi.fn(),
  })) as never,
  useLocation: ((options?: { select: (location: unknown) => unknown }) => {
    const location = { pathname: state.pathname, hash: "", state: {} };
    return options ? options.select(location) : location;
  }) as never,
  Outlet: (() => <StatefulContent />) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => {
  const { createContext, useContext } = await import("react");
  const Scope = createContext<ScopeState>(state.scope);
  return {
    ...(await original()),
    SettingsScopeProvider: (({ children }: { children: ReactNode }) => (
      <Scope value={state.scope}>{children}</Scope>
    )) as never,
    useSettingsScope: (() => {
      const { search, environmentId } = useContext(Scope);
      return {
        search,
        scope: { kind: "all" },
        environment: environmentId ? { environmentId } : null,
        connectedEnvironments: environmentId ? [{}] : [],
      };
    }) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock(import("../WorkspacePageHeader"), async (original) => ({
  ...(await original()),
  WorkspacePageHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock(import("./SettingsBreadcrumb"), async (original) => ({
  ...(await original()),
  SettingsBreadcrumb: (() => null) as never,
}));
vi.mock(import("../sidebar/mainAppLocation"), async (original) => ({
  ...(await original()),
  useNavigateToMainApp: () => vi.fn(),
}));
vi.mock(import("../../hooks/useNavigateBack"), async (original) => ({
  ...(await original()),
  useEscapeToGoBack: () => undefined,
}));
vi.mock(import("./SettingsPanels"), async (original) => ({
  ...(await original()),
  useSettingsRestore: (() => ({ changedSettingLabels: [] })) as never,
}));

import { Route } from "../../routes/settings";

function StatefulContent() {
  const [value, setValue] = useState(0);
  return (
    <button aria-label="Retained value" onClick={() => setValue(value + 1)}>
      {value}
    </button>
  );
}

const Layout = Route.options.component!;
await Layout.preload?.();

function setup(pathname: string, scope: ScopeState) {
  state.pathname = pathname;
  state.scope = scope;
}

const first = { search: { machine: "first", project: "one" }, environmentId: "first" };
const otherProject = { search: { machine: "first", project: "two" }, environmentId: "first" };
const otherMachine = { search: { machine: "second", project: "one" }, environmentId: "second" };
const implicitFirst = { search: { project: "one" }, environmentId: "first" };
const implicitSecond = { search: { project: "one" }, environmentId: "second" };

const disconnected = { search: first.search, environmentId: null };

it.each([
  ["/settings/diagnostics", "another project", "1", first, otherProject],
  ["/settings/providers", "another project", "1", first, otherProject],
  ["/settings/diagnostics", "another environment", "0", first, otherMachine],
  ["/settings/providers", "another environment", "0", first, otherMachine],
  ["/settings/diagnostics", "an implicit environment change", "0", implicitFirst, implicitSecond],
  ["/settings/providers", "an implicit environment change", "0", implicitFirst, implicitSecond],
  ["/settings/diagnostics", "a disconnect", "0", first, disconnected],
  ["/settings/keybindings", "another project", "0", first, otherProject],
])("%s after %s shows %s", async (pathname, _change, expected, before, after) => {
  setup(pathname, before);
  await using screen = await render(<Layout />);
  const { container } = screen;
  const retainedValue = () =>
    container.querySelector('button[aria-label="Retained value"]')?.textContent ?? null;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retained value"]')?.click(),
  );
  expect(retainedValue()).toBe("1");

  state.scope = after;
  await screen.rerender(<Layout />);

  expect(retainedValue()).toBe(expected);
});
