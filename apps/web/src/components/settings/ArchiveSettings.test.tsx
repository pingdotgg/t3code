import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: "" }),
  useNavigate: () => vi.fn(),
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
    snapshots: [],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

import { ArchivedThreadsPanel } from "./ArchiveSettings";

describe("ArchivedThreadsPanel", () => {
  it("exposes the upstream settings-search target on the persistent archive search field", () => {
    const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);

    expect(markup).toContain('id="archive"');
    expect(markup).toContain('aria-label="Search archived conversations"');
    expect(markup).toContain(">Archived threads</h2>");
  });
});
