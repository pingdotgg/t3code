import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const testDoubles = vi.hoisted(() => ({
  inputRef: null as Ref<HTMLInputElement> | null,
  navigate: vi.fn(),
  archiveState: {
    snapshots: [] as ReadonlyArray<unknown>,
    isLoading: false,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: "#archive" }),
  useNavigate: () => testDoubles.navigate,
}));

vi.mock("../ui/input", () => ({
  Input: ({
    ref,
    nativeInput: _nativeInput,
    ...inputProps
  }: ComponentProps<"input"> & { nativeInput?: boolean; ref?: Ref<HTMLInputElement> }) => {
    testDoubles.inputRef = ref ?? null;
    return <input {...inputProps} />;
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    selector({ confirmThreadDelete: true }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: testDoubles.archiveState.snapshots,
    error: null,
    isLoading: testDoubles.archiveState.isLoading,
    refresh: vi.fn(),
  }),
}));

import { ArchivedThreadsPanel } from "./ArchiveSettings";

afterEach(() => {
  testDoubles.inputRef = null;
  testDoubles.navigate.mockReset();
  testDoubles.archiveState.snapshots = [];
  testDoubles.archiveState.isLoading = false;
  vi.unstubAllGlobals();
});

describe("ArchivedThreadsPanel", () => {
  it.each([
    {
      archiveState: { snapshots: [], isLoading: false },
      expectedContent: "No archived threads",
      state: "empty",
    },
    {
      archiveState: { snapshots: [], isLoading: true },
      expectedContent: "Loading archived threads",
      state: "loading",
    },
    {
      archiveState: {
        snapshots: [
          {
            environmentId: "environment-1",
            snapshot: {
              snapshotSequence: 1,
              projects: [
                {
                  id: "project-1",
                  title: "Archive project",
                  workspaceRoot: "/workspaces/archive-project",
                  repositoryIdentity: null,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-06-01T00:00:00.000Z",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
              threads: [
                {
                  id: "thread-1",
                  projectId: "project-1",
                  title: "Archived conversation",
                  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  latestTurn: null,
                  createdAt: "2026-06-01T00:00:00.000Z",
                  updatedAt: "2026-06-02T00:00:00.000Z",
                  archivedAt: "2026-06-02T00:00:00.000Z",
                  session: null,
                  latestUserMessageAt: null,
                  settledOverride: null,
                  settledAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                },
              ],
              updatedAt: "2026-06-02T00:00:00.000Z",
            },
          },
        ],
        isLoading: false,
      },
      expectedContent: "Archive project",
      state: "populated",
    },
  ])(
    "focuses the persistent archive search field in the $state state",
    ({ archiveState, expectedContent }) => {
      testDoubles.archiveState.snapshots = archiveState.snapshots;
      testDoubles.archiveState.isLoading = archiveState.isLoading;
      const scrollIntoView = vi.fn();
      const focus = vi.fn();
      const classList = { remove: vi.fn(), add: vi.fn() };
      const addEventListener = vi.fn();
      vi.stubGlobal("window", {
        matchMedia: vi.fn(() => ({ matches: false })),
      });

      const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);
      const archiveInput = {
        tagName: "INPUT",
        firstElementChild: null,
        scrollIntoView,
        focus,
        classList,
        addEventListener,
        offsetWidth: 100,
      } as unknown as HTMLInputElement;

      if (typeof testDoubles.inputRef !== "function") {
        throw new Error("Expected the archive input to receive a callback ref");
      }
      testDoubles.inputRef(archiveInput);

      expect(markup).toContain('id="archive"');
      expect(markup).toContain('aria-label="Search archived conversations"');
      expect(markup).toContain(expectedContent);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(classList.remove).toHaveBeenCalledWith("settings-search-target-pulse");
      expect(classList.add).toHaveBeenCalledWith("settings-search-target-pulse");
      expect(testDoubles.navigate).toHaveBeenCalledWith({
        hash: "",
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
      });
    },
  );
});
