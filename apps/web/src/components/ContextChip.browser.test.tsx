import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { ContextChip, ContextChipLabel } from "./ContextChip";

// An empty inline-block's bottom edge sits on the baseline of the line it is in.
function BaselineMarker(props: { id: string }) {
  return <span data-baseline={props.id} className="inline-block size-0" />;
}

describe("ContextChip", () => {
  it("sets its label on the sentence baseline at the sentence size without growing the line", async () => {
    await using screen = await render(
      <p className="w-[60ch] text-sm leading-relaxed">
        Open
        <BaselineMarker id="text" /> the{" "}
        <ContextChip kind="mention" render={<button type="button" />}>
          <FileIcon />
          <ContextChipLabel>
            src/
            <BaselineMarker id="chip" />
            Typography.tsx
          </ContextChipLabel>
        </ContextChip>{" "}
        file
      </p>,
    );
    const paragraph = screen.container.querySelector("p")!;
    const label = screen.container.querySelector<HTMLElement>('[data-slot="context-chip-label"]')!;
    const baseline = (id: string) =>
      screen.container.querySelector(`[data-baseline="${id}"]`)!.getBoundingClientRect().bottom;

    expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(paragraph).fontSize);
    expect(Math.abs(baseline("chip") - baseline("text"))).toBeLessThanOrEqual(0.5);
    expect(paragraph.getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      0,
    );
  });
});
