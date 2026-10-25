import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessionAtom: {},
  searchEntries: vi.fn(() => null),
}));

vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => mocks.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("./pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.sessionAtom
        ? { authenticated: true, scopes: [AuthFilesystemReadScope] }
        : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

import { useComposerPathSearch, type ComposerPathSearchTarget } from "./queries";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.searchEntries.mockClear();
  const root = createRoot(document.createElement("div"));
  function Probe({ target }: { readonly target: ComposerPathSearchTarget }) {
    useComposerPathSearch(target);
    return null;
  }

  return {
    render(target: ComposerPathSearchTarget) {
      act(() => root.render(<Probe target={{ ...target }} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.useRealTimers();
    },
  };
}

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

it("keeps the original search deadline when rerenders have equivalent targets", () => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render({ ...target, query: " src " });
  act(() => vi.advanceTimersByTime(100));
  harness.render(target);
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, query: target.query, limit: 20 },
  });
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
  { field: "query", changed: { ...target, query: "test" } },
])("restarts the search deadline when the $field changes", ({ changed }) => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render(target);
  act(() => vi.advanceTimersByTime(100));
  harness.render(changed);

  act(() => vi.advanceTimersByTime(100));
  expect(mocks.searchEntries).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: changed.environmentId,
    input: { cwd: changed.cwd, query: changed.query, limit: 20 },
  });
});
