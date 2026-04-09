import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders command approval details when provided", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-1"),
          requestKind: "command",
          createdAt: "2026-04-03T00:00:00.000Z",
          detail: "/bin/zsh -lc \"printf 'command line 1\\n'\"",
        }}
        pendingCount={2}
      />,
    );

    expect(markup).toContain("PENDING APPROVAL");
    expect(markup).toContain("Command approval requested");
    expect(markup).toContain("1/2");
    expect(markup).toContain("Details");
    expect(markup).toContain("/bin/zsh -lc");
    expect(markup).toContain("whitespace-pre-wrap");
  });

  it("omits the details section when no approval detail exists", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-04-03T00:00:00.000Z",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("File-read approval requested");
    expect(markup).not.toContain("Details");
  });
});
