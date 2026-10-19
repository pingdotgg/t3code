import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Session = {
  _tag: "Success" | "Failure";
  waiting: boolean;
  value: { authenticated: boolean; permissions: string[] };
};
const state = vi.hoisted(() => ({
  id: 0,
  session: null as unknown as Session,
  add: vi.fn((_notice: unknown) => "notice"),
  close: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.session) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: `env-${state.id}`, label: "Work laptop" }],
  })) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add, close: state.close } as never,
  };
});
import { PermissionUpdateNotice } from "./PermissionUpdateNotice";

let root: Root;
let container: HTMLDivElement;
const storageKey = () => `t3code:permission-update:v1:env-${state.id}`;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.id++;
  state.session = {
    _tag: "Success",
    waiting: false,
    value: { authenticated: true, permissions: ["orchestration:operate"] },
  };
  vi.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  localStorage.clear();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<PermissionUpdateNotice />));
type Notice = {
  timeout: number;
  actionProps: { onClick: () => void };
  data: { secondaryActionProps: { onClick: () => void } };
};
const notice = () => state.add.mock.calls[0]![0] as Notice;

it("keeps the notice visible and persists dismissal, with a route to pairing settings", async () => {
  await render();
  expect(notice().timeout).toBe(0);
  expect(localStorage.getItem(storageKey())).toBeNull();
  notice().actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/connections" });
  expect(state.close).toHaveBeenCalledWith("notice");
  expect(localStorage.getItem(storageKey())).toBe("true");
});
it("does not repeat on session refresh or remount", async () => {
  await render();
  await act(async () => root.unmount());
  root = createRoot(container);
  state.session = { ...state.session };
  await render();
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("skips a notice dismissed on an earlier launch", async () => {
  localStorage.setItem(storageKey(), "true");
  await render();
  expect(state.add).not.toHaveBeenCalled();
});
it("waits for a successful, settled session check", async () => {
  state.session._tag = "Failure";
  await render();
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, _tag: "Success", waiting: true };
  await render();
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, waiting: false };
  await render();
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("does not warn for a granular grant", async () => {
  state.session.value.permissions.push("filesystem:read");
  await render();
  expect(state.add).not.toHaveBeenCalled();
});

it("persists the secondary dismissal without relying on the toast close callback", async () => {
  await render();
  notice().data.secondaryActionProps.onClick();
  expect(localStorage.getItem(storageKey())).toBe("true");
  expect(state.close).toHaveBeenCalledWith("notice");
});
