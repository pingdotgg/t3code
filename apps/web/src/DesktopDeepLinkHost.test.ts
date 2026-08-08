import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopDeepLinkNavigation } from "./DesktopDeepLinkHost";

describe("DesktopDeepLinkHost", () => {
  it("maps a desktop thread target to the canonical renderer route", () => {
    expect(
      resolveDesktopDeepLinkNavigation({
        type: "thread",
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    });
  });
});
