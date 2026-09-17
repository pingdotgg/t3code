import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";

const environmentId = "fd6fff30-f90b-4ee7-9812-4cf497791b90" as EnvironmentId;
const threadId = "a8395a98-a186-4fe7-9d4c-fb8ba63b7588" as ThreadId;

describe("threadNotificationTag", () => {
  it("stays under the platform toast tag budget", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(tag).toHaveLength(16);
    expect(tag.length).toBeLessThanOrEqual(32);
  });

  it("is stable for the same environment and thread", () => {
    expect(threadNotificationTag(environmentId, threadId)).toBe(
      threadNotificationTag(environmentId, threadId),
    );
  });

  it("separates environments and threads", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(threadNotificationTag("env-2" as EnvironmentId, threadId)).not.toBe(tag);
    expect(threadNotificationTag(environmentId, "thread-2" as ThreadId)).not.toBe(tag);
  });
});
