import { RuntimeRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions visible and secondary decisions in the menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-1")}
        isResponding={false}
        canRespond
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain(">Cancel<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("keeps secondary provider labels out of the compact action row", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-safari")}
        isResponding={false}
        canRespond
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).not.toContain("Always allow Safari");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("preserves provider labels for the main decisions", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        options={[
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(
      'aria-description="Untrusted files could re-run this action without asking."',
    );
    expect(markup).toContain("text-warning");
    expect(markup).toContain("Allow for this thread");
  });

  it("limits provider-supplied approval labels so narrow rows can wrap", () => {
    const label = "Allow ".repeat(40).trim();
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-long-label")}
        isResponding={false}
        canRespond
        options={[{ decision: "acceptAlways", label }]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain('class="max-w-40 truncate"');
    expect(markup).toContain(label);
  });
});
