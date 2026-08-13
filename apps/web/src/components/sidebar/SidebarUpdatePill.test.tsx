import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarUpdateDownloadProgress } from "./SidebarUpdatePill";

describe("SidebarUpdateDownloadProgress", () => {
  it("renders a determinate circular ring around the download icon", () => {
    const markup = renderToStaticMarkup(<SidebarUpdateDownloadProgress percent={42} />);

    expect(markup).toContain('stroke-dashoffset="58"');
    expect(markup).toContain('pathLength="100"');
    expect(markup).toContain('viewBox="0 0 32 32"');
    expect(markup).toContain("lucide-download");
  });
});
