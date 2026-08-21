import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  canDetach: false,
  relationships: [] as ReadonlyArray<unknown>,
}));

vi.mock("@t3tools/client-runtime/state/thread-relationships", () => ({
  deriveThreadRelationshipGraph: () => ({ nodes: new Map() }),
  immediateThreadRelationships: () => testState.relationships,
  orderWebThreadLineageRows: ({ rows }: { readonly rows: ReadonlyArray<unknown> }) => rows,
  resolveMergeBackTargetThreadId: () => null,
}));
vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  canDetachThreadProviderSession: () => testState.canDetach,
  resolveLatestMergeBackRun: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: { runs: [] } }),
  useThreadShells: () => [],
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    mergeBack: Symbol("mergeBack"),
    stopSession: Symbol("stopSession"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuItem: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import {
  resolveThreadLineageWindow,
  ThreadLineageRowList,
  ThreadRelationshipsPanel,
} from "./ThreadRelationshipsControl";

const environmentId = "environment:relationships" as EnvironmentId;
const threadId = "thread:relationships" as ThreadId;
const childThreadId = "thread:relationships:subagent" as ThreadId;

const renderPanel = () =>
  renderToStaticMarkup(
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={threadId} />,
  );

describe("ThreadRelationshipsPanel", () => {
  beforeEach(() => {
    testState.canDetach = false;
    testState.relationships = [
      {
        threadId: childThreadId,
        edge: {
          kind: "subagent",
          sourceThreadId: threadId,
          targetThreadId: childThreadId,
          status: "running",
        },
      },
    ];
  });

  it("keeps disconnect controls when hidden subagent edges are the only relationships", () => {
    testState.canDetach = true;

    const markup = renderPanel();

    expect(markup).toContain("Lineage");
    expect(markup).toContain("Agent session connected");
    expect(markup).toContain("Disconnect agent session");
    expect(markup).not.toContain('aria-label="Related threads"');
    expect(markup).not.toContain("Subagent");
  });

  it("renders nothing when no visible relationship or detachable session exists", () => {
    expect(renderPanel()).toBe("");
  });
});

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

function renderRowList(visibleCount: number) {
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, visibleCount);
  return renderToStaticMarkup(
    <ThreadLineageRowList hiddenCount={hiddenCount} onShowMore={() => {}}>
      {visibleRows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ThreadLineageRowList>,
  );
}

describe("thread lineage row list", () => {
  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("offers one page at a time", () => {
    expect(renderRowList(6)).toContain("Show 12 more");
    expect(renderRowList(6 + 12)).toContain("Show 2 more");
  });

  it("omits the expansion affordance when everything fits", () => {
    const markup = renderRowList(rows.length);

    expect(markup).not.toContain("more");
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });

  it("keeps the rows in a bounded, labelled scroll region and the button outside it", () => {
    const markup = renderRowList(6);
    const list = /<ul([^>]*)>/.exec(markup)?.[1] ?? "";

    expect(list).toContain('aria-label="Related threads"');
    expect(list).toContain("max-h-[13.5rem]");
    expect(list).toContain("overflow-y-auto");
    expect(list).toContain("overscroll-contain");
    expect(markup.indexOf("</ul>")).toBeLessThan(markup.indexOf("<button"));
  });
});
