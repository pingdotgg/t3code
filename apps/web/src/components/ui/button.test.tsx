import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { FlaskConicalIcon } from "lucide-react";

import { Button } from "./button";

describe("button geometry tokens", () => {
  it("uses the shared control radius and an opaque semantic icon color", () => {
    const html = renderToStaticMarkup(
      <Button size="icon-xs" variant="outline" aria-label="Run tests">
        <FlaskConicalIcon />
      </Button>,
    );

    expect(html).toContain("rounded-[var(--control-radius)]");
    expect(html).toContain("[--control-icon-color:var(--contrast-muted-foreground)]");
    expect(html).toContain("text-[var(--control-icon-color)]");
    expect(html).not.toContain("opacity-80");
  });

  it("keeps compact icon buttons square at every breakpoint", () => {
    const html = renderToStaticMarkup(
      <Button size="icon-xs" aria-label="Add action">
        <span>+</span>
      </Button>,
    );

    expect(html).toContain("size-7");
    expect(html).toContain("sm:size-6");
  });

  it("owns shared compact and micro control geometry", () => {
    const compact = renderToStaticMarkup(<Button size="compact">Condition</Button>);
    const microLabel = renderToStaticMarkup(
      <Button size="micro">
        <FlaskConicalIcon /> Run
      </Button>,
    );
    const micro = renderToStaticMarkup(
      <Button size="icon-micro" variant="ghost-muted" aria-label="Add action">
        <span>+</span>
      </Button>,
    );

    expect(compact).toContain("h-7");
    expect(compact).toContain("rounded-md");
    expect(microLabel).toContain("text-[11px]");
    expect(microLabel).toContain("sm:text-[11px]");
    expect(microLabel).toContain("sm:[&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3");
    expect(micro).toContain("size-5");
    expect(micro).toContain("rounded-sm");
    expect(micro).toContain("text-muted-foreground");
  });
});
