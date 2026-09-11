import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { useProjectFaviconColor } = vi.hoisted(() => ({
  useProjectFaviconColor: vi.fn(
    (input: { readonly cwd: string }) => `rgb(${input.cwd.length} 40 80)`,
  ),
}));

vi.mock("./ProjectFavicon", () => ({ useProjectFaviconColor }));

import {
  SidebarProjectFaviconColorResolvers,
  type SidebarProjectFaviconColorSource,
} from "./SidebarProjectFaviconColors";

function source(projectKey: string, cwd: string): SidebarProjectFaviconColorSource {
  return {
    projectKey,
    environmentId: "environment-test" as EnvironmentId,
    cwd,
    faviconPath: null,
    projectIcon: null,
  };
}

describe("SidebarProjectFaviconColorResolvers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves favicon color once per project instead of once per thread", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onColor = vi.fn();
    const analytics = source("environment-test:analytics", "/work/analytics");
    const storefront = source("environment-test:storefront", "/work/storefront");
    const repeatedThreadSources = [
      ...Array.from({ length: 40 }, () => analytics),
      ...Array.from({ length: 30 }, () => storefront),
    ];
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <SidebarProjectFaviconColorResolvers sources={repeatedThreadSources} onColor={onColor} />,
        );
      });

      expect(useProjectFaviconColor).toHaveBeenCalledTimes(2);
      expect(onColor).toHaveBeenCalledTimes(2);
      expect(onColor).toHaveBeenCalledWith(
        analytics.projectKey,
        `rgb(${analytics.cwd.length} 40 80)`,
      );
      expect(onColor).toHaveBeenCalledWith(
        storefront.projectKey,
        `rgb(${storefront.cwd.length} 40 80)`,
      );
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("does not subscribe or sample when a project has a custom icon", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <SidebarProjectFaviconColorResolvers
            sources={[
              {
                ...source("environment-test:custom", "/work/custom"),
                projectIcon: { kind: "emoji", emoji: "🤖" },
              },
            ]}
            onColor={vi.fn()}
          />,
        );
      });

      expect(useProjectFaviconColor).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
