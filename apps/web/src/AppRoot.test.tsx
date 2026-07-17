import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(3);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
    expect(isValidElement(children[1]) && children[1].type).toBe(PreviewAutomationHosts);
    expect(isValidElement(children[2]) && children[2].type).toBe(ElectronBrowserHost);
  });
});
