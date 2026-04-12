import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinuxWindowControls } from "./LinuxWindowControls";

const testWindow = { desktopBridge: undefined };

describe("LinuxWindowControls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders buttons as a simple inline row", () => {
    vi.stubGlobal("window", testWindow);

    const markup = renderToStaticMarkup(<LinuxWindowControls actions={["minimize"]} />);

    expect(markup).toContain("flex shrink-0 items-center gap-1");
    expect(markup).not.toContain("absolute inset-x-3");
    expect(markup).toContain('aria-label="minimize"');
  });

  it("renders multiple buttons in order", () => {
    vi.stubGlobal("window", testWindow);

    const markup = renderToStaticMarkup(<LinuxWindowControls actions={["minimize", "close"]} />);

    expect(markup).toContain('aria-label="minimize"');
    expect(markup).toContain('aria-label="close"');
  });
});
