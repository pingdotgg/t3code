import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch } from "./diffRouteSearch";
import { resolveSplitThreadRefFromSearch } from "./threadSplitView";

describe("resolveSplitThreadRefFromSearch", () => {
  it("returns null when split matches path thread", () => {
    const env = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-1");
    const path = scopeThreadRef(env, threadId);
    expect(
      resolveSplitThreadRefFromSearch(
        path,
        parseDiffRouteSearch({
          splitEnvironmentId: env,
          splitThreadId: threadId,
        }),
      ),
    ).toBeNull();
  });

  it("returns secondary ref when split differs from path", () => {
    const env = EnvironmentId.make("environment-a");
    const path = scopeThreadRef(env, ThreadId.make("thread-1"));
    const secondary = scopeThreadRef(env, ThreadId.make("thread-2"));
    expect(
      resolveSplitThreadRefFromSearch(
        path,
        parseDiffRouteSearch({
          splitEnvironmentId: secondary.environmentId,
          splitThreadId: secondary.threadId,
        }),
      ),
    ).toEqual(secondary);
  });
});
