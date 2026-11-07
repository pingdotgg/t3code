import { type AssistantCitation, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function Timeline({ onCite }: { onCite: (citation: AssistantCitation) => boolean }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div ref={setViewport} className="h-80 w-[640px] overflow-y-auto p-6 text-sm">
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
      <div data-assistant-citation-source="message-1">
        <p>
          The migration gate runs first, and the <span>keepers</span> decide which rows survive the
          rewrite before the old table is dropped.
        </p>
      </div>
    </div>
  );
}

describe("AssistantSelectionToolbar", () => {
  it("does not cite when the user clicks just past where a double-click selection ended", async () => {
    const onCite = vi.fn((_citation: AssistantCitation) => true);
    await using screen = await render(<Timeline onCite={onCite} />);
    const word = screen.getByText("keepers");
    const { width, height } = word.element().getBoundingClientRect();
    const released = { x: width / 2, y: height / 2 };

    await userEvent.dblClick(word, { position: released });
    await expect
      .element(page.getByRole("button", { name: "Cite selection in composer" }))
      .toBeVisible();

    // force: Playwright otherwise waits for whatever covers the point to move away.
    await userEvent.click(word, {
      position: { x: released.x + 5, y: released.y + 5 },
      force: true,
    });
    expect(onCite.mock.calls.map(([citation]) => citation.text)).toEqual([]);
  });
});
