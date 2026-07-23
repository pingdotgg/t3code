import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasCustomHomeListOptions, type HomeListOptions } from "./home-list-options";

const defaults: HomeListOptions = {
  selectedEnvironmentId: null,
  projectSortOrder:
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
};

describe("home list options", () => {
  it("recognizes default options", () => {
    expect(hasCustomHomeListOptions(defaults)).toBe(false);
  });

  it("marks environment filters as customized", () => {
    expect(
      hasCustomHomeListOptions({ ...defaults, selectedEnvironmentId: "environment-1" as never }),
    ).toBe(true);
    expect(
      hasCustomHomeListOptions({ ...defaults, selectedProjectKey: "environment-1:project-1" }),
    ).toBe(true);
  });
});
