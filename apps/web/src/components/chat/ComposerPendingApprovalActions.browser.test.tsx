import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerBanner } from "./ComposerBanner";

const rowLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim())
    .filter(Boolean);

describe("ComposerPendingApprovalActions", () => {
  it("keeps decisions visible while a long network approval explanation scrolls", async () => {
    const title = "command argument ".repeat(400) + "END_OF_EXPLANATION";
    const onRespond = vi.fn(async () => undefined);
    for (const width of [1000, 460]) {
      const container = document.createElement("div");
      container.style.width = `${width}px`;
      await using _screen = await render(
        <ComposerBanner.Root variant="warning" density="spacious">
          <ComposerBanner.Row layout="approval">
            <ComposerBanner.Content>
              <ComposerPendingApprovalPanel
                approval={{
                  requestId: RuntimeRequestId.make("approval-1"),
                  requestKind: "command",
                  createdAt: "2026-06-20T00:00:00.000Z",
                  responseCapability: "live",
                  detail: "https example.com",
                  title,
                }}
                pendingCount={1}
              />
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerPendingApprovalActions
                requestId={RuntimeRequestId.make("approval-1")}
                canRespond
                isResponding={false}
                onRespondToApproval={onRespond}
              />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>,
        { container },
      );
      const explanation = container.querySelector<HTMLElement>(
        '[aria-label="Command approval"] > span > span:nth-child(2)',
      )!;
      expect(explanation.textContent).toBe(title);
      expect(explanation.clientHeight).toBeLessThanOrEqual(40);
      expect(explanation.scrollHeight).toBeGreaterThan(explanation.clientHeight);
      expect(explanation.scrollWidth).toBeLessThanOrEqual(explanation.clientWidth);
      expect(container.getBoundingClientRect().height).toBeLessThan(240);
      explanation.scrollTop = explanation.scrollHeight;
      const node = explanation.firstChild!;
      const end = document.createRange();
      end.setStart(node, title.indexOf("END_OF_EXPLANATION"));
      end.setEnd(node, title.length);
      expect(end.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        explanation.getBoundingClientRect().bottom,
      );
      expect(rowLabels(container)).toEqual(["Decline", "Approve"]);
    }
  });
});
import "~/index.css";
