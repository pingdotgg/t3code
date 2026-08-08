import type { WorkingCopyStatusResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DiffPanelShell } from "../DiffPanelShell";
import { CommitComposer } from "./CommitComposer";
import { SourceControlHeader } from "./SourceControlHeader";
import { SourceControlPanelShell } from "./SourceControlPanelShell";

const noop = () => undefined;
const status: WorkingCopyStatusResult = {
  isRepo: true,
  refName: "main",
  detached: false,
  ahead: 1,
  behind: 0,
  hasUpstream: true,
  files: [],
  operationInProgress: null,
};

function renderHeader(over: Partial<Parameters<typeof SourceControlHeader>[0]> = {}) {
  const props: Parameters<typeof SourceControlHeader>[0] = {
    status,
    repoLabel: "t3code",
    activeSection: "changes",
    searchActive: false,
    syncBusy: false,
    pendingSyncKind: null,
    actionsBusy: false,
    dirtyCount: 3,
    undoBusy: false,
    discardAllBusy: false,
    stashBusy: false,
    refreshBusy: false,
    viewActions: <span data-test-view-actions />,
    onSelectSection: noop,
    onToggleSearch: noop,
    onSync: noop,
    onUndoLastCommit: noop,
    onDiscardAll: noop,
    onOpenStashDialog: noop,
    onOpenStashes: noop,
    onRefresh: noop,
    ...over,
  };
  return renderToStaticMarkup(<SourceControlHeader {...props} />);
}

describe("SourceControlHeader", () => {
  it("keeps repository context and the VS Code-style toolbar in one compact row", () => {
    const markup = renderHeader();

    expect(markup).toContain("t3code");
    expect(markup).toContain("main");
    expect(markup).toContain('aria-label="Filter source control"');
    expect(markup).toContain('aria-label="Show commit history"');
    expect(markup).toContain('aria-label="Refresh source control"');
    expect(markup).toContain("data-test-view-actions");
  });

  it("collapses the clean tracking refresh into one toolbar action", () => {
    const markup = renderHeader({ status: { ...status, ahead: 0 } });

    expect(markup.match(/lucide-refresh-cw/g)).toHaveLength(1);
    expect(markup).not.toContain('<span class="max-w-14 truncate">Refresh</span>');
  });

  it("shows and disables the complete pending push state", () => {
    const markup = renderHeader({
      syncBusy: true,
      pendingSyncKind: "push",
      actionsBusy: true,
    });

    expect(markup).toContain("Pushing…");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="More source control actions" disabled=""');
  });
});

describe("SourceControlPanelShell", () => {
  it("uses the same sidebar surface as the project and session panel", () => {
    const markup = renderToStaticMarkup(
      <SourceControlPanelShell mode="inline">
        <DiffPanelShell className="bg-transparent" header={<span>Repository</span>} mode="embedded">
          <div>Changes</div>
        </DiffPanelShell>
      </SourceControlPanelShell>,
    );

    expect(markup).toContain('data-sidebar-version="v2"');
    expect(markup).toContain("bg-sidebar surface-grain text-sidebar-foreground");
    expect(markup).toContain("flex h-full min-w-0 flex-col w-full bg-transparent");
    expect(markup).not.toContain("flex h-full min-w-0 flex-col w-full bg-background");
  });
});

describe("CommitComposer", () => {
  it("renders the message first and a full-width primary action below it", () => {
    const markup = renderToStaticMarkup(
      <CommitComposer
        message="feat: compact source control"
        onMessageChange={noop}
        amend={false}
        onAmendChange={noop}
        lastCommitMessage={null}
        stagedCount={1}
        dirtyCount={1}
        ahead={0}
        operationInProgress={false}
        busy={false}
        primaryVariant="default"
        onCommit={noop}
        onAmend={noop}
        onPush={noop}
        onCommitAndPush={noop}
      />,
    );

    expect(markup).toContain("Message (Ctrl+Enter to commit)");
    expect(markup).toContain("data-source-control-commit-composer");
    expect(markup).toContain("flex-1 justify-center rounded-e-none");
    expect(markup.indexOf('aria-label="Commit message"')).toBeLessThan(
      markup.indexOf(">Commit</button>"),
    );
  });

  it("keeps the commit button disabled and visibly pending across multi-step work", () => {
    const markup = renderToStaticMarkup(
      <CommitComposer
        message="feat: compact source control"
        onMessageChange={noop}
        amend={false}
        onAmendChange={noop}
        lastCommitMessage={null}
        stagedCount={0}
        dirtyCount={2}
        ahead={0}
        operationInProgress={false}
        busy
        pendingLabel="Committing all…"
        primaryVariant="default"
        onCommit={noop}
        onAmend={noop}
        onPush={noop}
        onCommitAndPush={noop}
      />,
    );

    expect(markup).toContain("Committing all…");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="Commit message"/);
  });
});
