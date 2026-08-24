import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("states that the persistent approval lasts for this session", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Always allow this session");
    expect(markup).not.toContain(">Always allow<");
    expect(markup).toContain("h-5");
    expect(markup).toContain("sm:text-[11px]");
    expect(markup).not.toContain("sm:h-6");
  });

  it("shows only the approval choices advertised by an MCP server", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-safari")}
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Always allow Safari");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("limits provider-supplied approval labels so narrow rows can wrap", () => {
    const label = "Allow ".repeat(40).trim();
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-long-label")}
        isResponding={false}
        options={[{ decision: "acceptAlways", label }]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain('class="max-w-40 truncate"');
    expect(markup).toContain(label);
  });
});
