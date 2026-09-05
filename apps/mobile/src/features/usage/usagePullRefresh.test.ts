import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isUsagePullRefreshPending, usagePullRefreshTargets } from "./usagePullRefresh";

const status = (environmentId: string, summary: unknown | null, isPending: boolean) => ({
  environmentId: environmentId as EnvironmentId,
  summary,
  isPending,
});

describe("usage pull refresh", () => {
  it("follows previously answered environments across a rebased 24-hour window", () => {
    const targets = usagePullRefreshTargets([
      status("answered", { readAt: "before" }, false),
      status("unreachable", null, true),
    ]);

    expect(
      isUsagePullRefreshPending(
        [status("answered", null, true), status("unreachable", null, true)],
        targets,
      ),
    ).toBe(true);
    expect(
      isUsagePullRefreshPending(
        [status("answered", { readAt: "after" }, false), status("unreachable", null, true)],
        targets,
      ),
    ).toBe(false);
  });
});
