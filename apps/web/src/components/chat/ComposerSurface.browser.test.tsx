import "~/index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";

it("masks the toolbar overlap and reveals its surface one pixel before the input edge", async () => {
  await using screen = await render(
    <ComposerSurface.Shell contextStrip>
      <ComposerSurface.Host>Message</ComposerSurface.Host>
      <ComposerSurface.ContextStrip>Workspace</ComposerSurface.ContextStrip>
    </ComposerSurface.Shell>,
  );

  const strip = screen.container.querySelector('[data-slot="composer-context-strip"]')!;
  const mask = getComputedStyle(strip, "::before").maskImage;
  expect(mask).toContain("rgba(0, 0, 0, 0) 15px, rgb(0, 0, 0) 15px");
});
