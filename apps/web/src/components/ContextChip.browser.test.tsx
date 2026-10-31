import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { ContextChip, ContextChipLabel } from "./ContextChip";

describe("ContextChip", () => {
  it("scales its label with the sentence without growing the line", async () => {
    await using screen = await render(
      <p className="w-[60ch] text-sm leading-relaxed">
        Open the{" "}
        <ContextChip kind="mention" render={<button type="button" />}>
          <FileIcon />
          <ContextChipLabel>src/Typography.tsx</ContextChipLabel>
        </ContextChip>{" "}
        file
      </p>,
    );
    const paragraph = screen.container.querySelector("p")!;
    const label = screen.container.querySelector<HTMLElement>('[data-slot="context-chip-label"]')!;
    const sentenceSize = Number.parseFloat(getComputedStyle(paragraph).fontSize);
    const chipSize = Number.parseFloat(getComputedStyle(label).fontSize);

    expect(chipSize / sentenceSize).toBeCloseTo(0.86, 2);
    expect(paragraph.getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      0,
    );
  });
});
