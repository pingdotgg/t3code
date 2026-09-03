import { renderToStaticMarkup } from "react-dom/server";
import { BotIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
} from "./ComposerControl";

describe("ComposerControl", () => {
  it("preserves the expanded composer geometry by default", () => {
    const markup = renderToStaticMarkup(<ComposerControl>Model</ComposerControl>);

    expect(markup).toContain("h-7");
    expect(markup).toContain("min-h-7");
    expect(markup).toContain("gap-1.5");
    expect(markup).toContain("px-2.5");
  });

  it("uses the shared xs geometry for resting controls", () => {
    const markup = renderToStaticMarkup(
      <ComposerControl size="xs">
        Model
        <ComposerControlChevron size="xs" />
      </ComposerControl>,
    );

    expect(markup).toContain("sm:h-6");
    expect(markup).toContain("font-normal");
    expect(markup).toContain("text-muted-foreground/70");
    expect(markup).toContain("[--control-icon-color:currentColor]");
    expect(markup).toContain("svg[data-composer-control-chevron]]:ms-0");
    expect(markup).toContain("svg[data-composer-control-chevron]]:-me-1");
    expect(markup).not.toContain("min-h-7");
    expect(markup).not.toContain("gap-1.5");
    expect(markup).not.toContain("px-2.5");
  });

  it("keeps the expanded chevron treatment unless resting overrides it", () => {
    const expanded = renderToStaticMarkup(<ComposerControlChevron />);
    const resting = renderToStaticMarkup(<ComposerControlChevron size="xs" />);

    expect(expanded).toContain("size-3.5");
    expect(expanded).toContain("text-icon-muted");
    expect(expanded).toContain('stroke-width="2.25"');
    expect(resting).toContain("size-3");
    expect(resting).toContain("text-current");
    expect(resting).toContain("opacity-50");
    expect(resting).not.toContain("size-3.5");
    expect(resting).not.toContain("text-icon-muted");
  });

  it("owns resting icon geometry", () => {
    const expanded = renderToStaticMarkup(<ComposerControlIcon icon={BotIcon} />);
    const resting = renderToStaticMarkup(<ComposerControlIcon icon={BotIcon} size="xs" />);

    expect(expanded).toContain("size-4");
    expect(resting).toContain("size-3");
    expect(resting).not.toContain("size-4");
  });

  it("owns separator geometry for both composer sizes", () => {
    const expanded = renderToStaticMarkup(<ComposerControlSeparator />);
    const resting = renderToStaticMarkup(
      <ComposerControlSeparator size="xs" data-resting-controls-separator="true" />,
    );

    expect(expanded).toContain("h-4");
    expect(expanded).not.toContain("h-3.5!");
    expect(resting).toContain("h-3.5!");
    expect(resting).not.toContain("h-4");
    expect(resting).toContain('data-resting-controls-separator="true"');
  });
});
