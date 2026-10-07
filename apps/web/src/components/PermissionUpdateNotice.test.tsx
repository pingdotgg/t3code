import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  id: 0,
  saved: false,
  session: {
    _tag: "Success",
    waiting: false,
    value: { authenticated: true, permissions: ["orchestration:operate"] },
  },
  add: vi.fn((_notice: unknown) => "notice"),
  close: vi.fn(),
  save: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.session }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: `env-${state.id}`, label: "Work laptop" }],
  }),
}));
vi.mock("../state/session", () => ({ environmentSession: { sessionStateAtom: () => null } }));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => state.saved,
  setLocalStorageItem: (...args: unknown[]) => state.save(...args),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add, close: state.close } }));
import { PermissionUpdateNotice } from "./PermissionUpdateNotice";

let renderer: ReactTestRenderer;
beforeEach(() => {
  state.id++;
  state.saved = false;
  state.session = {
    _tag: "Success",
    waiting: false,
    value: { authenticated: true, permissions: ["orchestration:operate"] },
  };
  vi.clearAllMocks();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render() {
  await act(async () => {
    renderer = create(<PermissionUpdateNotice />);
  });
}

it("keeps the notice visible and persists dismissal, with a route to pairing settings", async () => {
  await render();
  const notice = state.add.mock.calls[0]![0] as unknown as {
    timeout: number;
    onClose: () => void;
    actionProps: { onClick: () => void };
  };
  expect(notice.timeout).toBe(0);
  expect(state.save).not.toHaveBeenCalled();
  notice.actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/connections" });
  expect(state.close).toHaveBeenCalledWith("notice");
  notice.onClose();
  expect(state.save).toHaveBeenCalledWith(
    `t3code:permission-update:v1:env-${state.id}`,
    true,
    expect.anything(),
  );
});
it("does not repeat on session refresh or remount", async () => {
  await render();
  await act(async () => renderer.unmount());
  state.session = { ...state.session };
  await render();
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("skips a notice dismissed on an earlier launch", async () => {
  state.saved = true;
  await render();
  expect(state.add).not.toHaveBeenCalled();
});
it("waits for a successful, settled session check", async () => {
  state.session._tag = "Failure";
  await render();
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, _tag: "Success", waiting: true };
  await act(async () => renderer.update(<PermissionUpdateNotice />));
  expect(state.add).not.toHaveBeenCalled();
  state.session = { ...state.session, waiting: false };
  await act(async () => renderer.update(<PermissionUpdateNotice />));
  expect(state.add).toHaveBeenCalledTimes(1);
});
it("does not warn for a granular grant", async () => {
  state.session.value.permissions.push("filesystem:read");
  await render();
  expect(state.add).not.toHaveBeenCalled();
});
