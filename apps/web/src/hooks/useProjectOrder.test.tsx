import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ persist: vi.fn(), toast: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.persist }));
vi.mock("../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments }),
  usePrimaryEnvironmentId: () => primaryId,
}));

// Fresh modules per test so no pending reorder leaks between cases.
let useProjectOrder: typeof import("./useProjectOrder").useProjectOrder;
let useReorderProjects: typeof import("./useProjectOrder").useReorderProjects;
let reorderProjectKeys: typeof import("./useProjectOrder").reorderProjectKeys;

function environment(id: string, order: readonly string[] | null) {
  return {
    environmentId: id,
    label: id,
    connection: { phase: "connected" },
    serverConfig: { settings: { sidebarProjectOrder: order } },
  };
}

let primaryId: string | null;
let environments: ReturnType<typeof environment>[];
let renderer: ReactTestRenderer;
let displayed: readonly string[];
let reorder: ReturnType<typeof useReorderProjects>;
function Probe() {
  const order = useProjectOrder();
  const move = useReorderProjects();
  useLayoutEffect(() => {
    displayed = order;
    reorder = move;
  });
  return null;
}

beforeEach(async () => {
  vi.resetModules();
  ({ useProjectOrder, useReorderProjects, reorderProjectKeys } = await import("./useProjectOrder"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.persist.mockReset().mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
  mocks.toast.mockReset();
  primaryId = null;
  environments = [environment("remote", null)];
  act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("restores server order on a fresh remote client and follows broadcasts", () => {
  environments = [environment("remote", ["remote:/b", "remote:/a"])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(["remote:/b", "remote:/a"]);
  environments = [environment("remote", ["remote:/a", "remote:/b"])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(["remote:/a", "remote:/b"]);
  expect(mocks.persist).not.toHaveBeenCalled();
});

it("saves grouped order to one stable hosted server and restores it after remount", async () => {
  environments = [environment("b", null), environment("a", null)];
  act(() => renderer.update(<Probe />));
  const current = ["a:/repo", "b:/repo", "a:/other"];
  await act(async () => reorder(current, ["a:/repo", "b:/repo"], ["a:/other"]));
  expect(displayed).toEqual(["a:/other", "a:/repo", "b:/repo"]);
  expect(mocks.persist.mock.calls.map(([call]) => call.environmentId)).toEqual(["a"]);
  const saved = mocks.persist.mock.calls[0]![0].input.patch.sidebarProjectOrder;
  environments = [environment("a", saved), environment("b", null)];
  act(() => renderer.update(<Probe />));
  act(() => renderer.unmount());
  act(() => {
    renderer = create(<Probe />);
  });
  expect(displayed).toEqual(["a:/other", "a:/repo", "b:/repo"]);
});

it("warns on a failed save and restores the authoritative server order", async () => {
  const original = ["remote:/a", "remote:/b"];
  environments = [environment("remote", original)];
  mocks.persist.mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
  act(() => renderer.update(<Probe />));
  await act(async () => reorder(original, ["remote:/a"], ["remote:/b"]));
  expect(displayed).toEqual(original);
  expect(mocks.toast).toHaveBeenCalled();
});

it("uses the primary server when one exists", async () => {
  primaryId = "b";
  environments = [environment("a", ["a:/a"]), environment("b", ["b:/b", "b:/a"])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(["b:/b", "b:/a"]);
  await act(async () => reorder(displayed, ["b:/a"], ["b:/b"]));
  expect(mocks.persist.mock.calls.map(([call]) => call.environmentId)).toEqual(["b"]);
});

it("shows a reorder immediately and hands off to the server broadcast", async () => {
  const original = ["remote:/a", "remote:/b", "remote:/c"];
  environments = [environment("remote", original)];
  let finish: (value: unknown) => void = () => {};
  mocks.persist.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  act(() => renderer.update(<Probe />));
  let saved: Promise<void> | undefined;
  act(() => {
    saved = reorder(original, ["remote:/a"], ["remote:/c"]);
  });
  expect(displayed).toEqual(["remote:/b", "remote:/c", "remote:/a"]);
  await act(async () => {
    finish(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
    await saved;
  });
  expect(displayed).toEqual(["remote:/b", "remote:/c", "remote:/a"]);
  environments = [environment("remote", ["remote:/c", "remote:/b", "remote:/a"])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(["remote:/c", "remote:/b", "remote:/a"]);
});

it("keeps a second quick drag when the first save broadcasts first", () => {
  const original = ["remote:/a", "remote:/b", "remote:/c"];
  environments = [environment("remote", original)];
  mocks.persist.mockReturnValue(new Promise(() => {}));
  act(() => renderer.update(<Probe />));
  act(() => {
    void reorder(original, ["remote:/a"], ["remote:/c"]);
  });
  const first = displayed;
  act(() => {
    void reorder(first, ["remote:/b"], ["remote:/a"]);
  });
  const second = displayed;
  expect(second).toEqual(["remote:/c", "remote:/a", "remote:/b"]);
  environments = [environment("remote", [...first])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(second);
});

it("keeps projects this client cannot see next to the project they followed", async () => {
  environments = [environment("a", ["a:/1", "b:/hidden", "a:/2", "a:/3"])];
  act(() => renderer.update(<Probe />));
  await act(async () => reorder(["a:/1", "a:/2", "a:/3"], ["a:/3"], ["a:/1"]));
  const saved = mocks.persist.mock.calls[0]![0].input.patch.sidebarProjectOrder;
  expect(saved).toEqual(["a:/3", "a:/1", "b:/hidden", "a:/2"]);
});

it("keeps a pending reorder through an unrelated settings broadcast", () => {
  const original = ["remote:/a", "remote:/b"];
  environments = [environment("remote", original)];
  mocks.persist.mockReturnValue(new Promise(() => {}));
  act(() => renderer.update(<Probe />));
  act(() => {
    void reorder(original, ["remote:/a"], ["remote:/b"]);
  });
  environments = [environment("remote", [...original])];
  act(() => renderer.update(<Probe />));
  expect(displayed).toEqual(["remote:/b", "remote:/a"]);
});

it("moves grouped project members together and ignores no-op drags", () => {
  const order = ["local:/a", "remote:/a", "local:/b", "local:/c"];
  expect(reorderProjectKeys(order, ["local:/a", "remote:/a"], ["local:/c"])).toEqual([
    "local:/b",
    "local:/c",
    "local:/a",
    "remote:/a",
  ]);
  expect(reorderProjectKeys(order, ["local:/missing"], ["local:/b"])).toBeNull();
  expect(reorderProjectKeys(order, ["local:/a"], ["local:/a"])).toBeNull();
});
