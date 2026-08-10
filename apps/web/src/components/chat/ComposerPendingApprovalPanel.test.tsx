import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
  });

  it("labels permission requests clearly", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-permissions"),
          requestKind: "permissions",
          createdAt: "2026-08-10T00:00:00.000Z",
          detail: "Allow Computer Use to view and control the desktop",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Permission requested");
    expect(markup).toContain('aria-label="Requested permissions"');
  });

  it("distinguishes generic tool approvals from permission requests", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-tool"),
          requestKind: "tool",
          createdAt: "2026-08-10T00:00:00.000Z",
          detail: "Allow node_repl to run?",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Tool approval requested");
    expect(markup).toContain('aria-label="Tool request"');
    expect(markup).not.toContain("Permission requested");
  });
});
