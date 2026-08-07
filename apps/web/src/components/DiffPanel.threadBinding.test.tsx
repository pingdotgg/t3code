import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const { useThreadMock } = vi.hoisted(() => ({
  useThreadMock: vi.fn(() => null),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffIgnoreWhitespace: false,
    timestampFormat: "relative",
    wordWrap: false,
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    inferredCheckpointTurnCountByTurnId: new Map(),
    turnDiffSummaries: [],
  }),
}));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("../state/entities", () => ({
  useProject: () => null,
  useThread: useThreadMock,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./sourceControl/useDiffHunkStaging", () => ({
  useDiffHunkStaging: () => ({
    active: false,
    clusters: [],
    confirmDialog: null,
    error: null,
    isPending: false,
    label: "",
    patch: null,
    pendingKey: null,
    renderCluster: vi.fn(),
    sectionId: "working-copy",
    truncated: false,
  }),
}));
vi.mock("./sourceControl/useDraftDiffTarget", () => ({
  useDraftDiffTarget: () => ({ cwd: null, environmentId: null, threadRef: null }),
}));

import DiffPanel from "./DiffPanel";

const GRID_THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-grid"),
  ThreadId.make("thread-grid"),
);

describe("DiffPanel thread binding", () => {
  it("uses the owning chat surface thread without requiring route params", () => {
    renderToStaticMarkup(
      <DiffPanel
        composerDraftTarget={GRID_THREAD_REF}
        initialGitScope="unstaged"
        mode="embedded"
        threadRef={GRID_THREAD_REF}
      />,
    );

    expect(useThreadMock).toHaveBeenCalledWith(GRID_THREAD_REF);
  });
});
