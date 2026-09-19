import type { StorageCleanupPreview } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  results: [] as Array<AsyncResult.AsyncResult<StorageCleanupPreview, Error>>,
  projectId: null as string | null,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.results,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { storageUsage: () => Atom.make(AsyncResult.initial()) },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environments = ["a", "b"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      serverConfig: { environment: { capabilities: { storageCleanupPreview: true } } },
    }));
    return {
      targets: environments.map((environment) => ({ ...environment, projectId: state.projectId })),
      environments,
      connectedEnvironments: environments,
    };
  },
}));
import { useStorageUsage } from "./useStorageUsage";

const summary: StorageCleanupPreview = {
  checkedAt: "2026-09-19T00:00:00.000Z",
  unchecked: 0,
  unavailable: 0,
  total: { folders: 1, measured: 1, bytes: 100 },
  categories: [{ kind: "inactive", folders: 1, measured: 1, bytes: 100 }],
  projectCount: 1,
};
let view: ReturnType<typeof useStorageUsage>;
function Probe({ days }: { days: number }) {
  const result = useStorageUsage(days);
  useEffect(() => {
    view = result;
  }, [result]);
  return null;
}
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  state.projectId = null;
});

describe("storage preview transitions", () => {
  it("keeps the previous breakdown during a day edit but drops it on scope changes", async () => {
    state.results = [AsyncResult.success(summary), AsyncResult.success(summary)];
    await act(async () => {
      renderer = create(<Probe days={8} />);
    });
    expect(view.data?.total.bytes).toBe(200);
    state.results = [AsyncResult.initial(true), AsyncResult.initial(true)];
    await act(async () => renderer!.update(<Probe days={30} />));
    expect(view.data?.total.bytes).toBe(200);
    expect(view.recalculatingInactive).toBe(true);
    state.projectId = "another-project";
    await act(async () => renderer!.update(<Probe days={30} />));
    expect(view.data).toBeNull();
  });

  it("excludes failed-server figures even while a different server is still loading", async () => {
    state.results = [AsyncResult.success(summary), AsyncResult.success(summary)];
    await act(async () => {
      renderer = create(<Probe days={8} />);
    });
    state.results = [
      AsyncResult.failure(Cause.fail(new Error("offline"))),
      { ...AsyncResult.success(summary), waiting: true },
    ];
    await act(async () => renderer!.update(<Probe days={30} />));
    expect(view.data?.total.bytes).toBe(100);
    expect(view.failed).toEqual(["a"]);
    expect(view.partial).toBe(true);
  });
});
