import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarStageBackdrop } from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it.each(["nightly", "dev"] as const)(
    "renders the %s artwork without animation hooks",
    (variant) => {
      const markup = renderToStaticMarkup(<SidebarStageBackdrop variant={variant} />);

      expect(markup).toContain("sidebar-stage-backdrop");
      expect(markup).not.toContain("animation");
      expect(markup).not.toMatch(/stage-(?:star|cloud|bp-dash|bp-mark)/);
    },
  );
});
