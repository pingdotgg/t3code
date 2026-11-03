import { describe, expect, it } from "vite-plus/test";

import { layoutRoutePage } from "./pageNavigation";

describe("layoutRoutePage", () => {
  it("shows every pull requests URL as the layout's page tab", () => {
    for (const href of ["/pull-requests?state=open", "/pull-requests?pane=1&state=open"]) {
      expect(layoutRoutePage({ pathname: "/pull-requests", href })).toEqual({
        kind: "pull-requests",
        href,
      });
    }
  });

  it("leaves Settings and Usage to their modals", () => {
    for (const pathname of ["/settings/general", "/usage"]) {
      expect(layoutRoutePage({ pathname, href: pathname })).toBeNull();
    }
  });
});
