import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";

const environmentId = "fd6fff30-f90b-4ee7-9812-4cf497791b90" as EnvironmentId;
const otherEnvironmentId = "25b62992-b996-4ee3-8d82-d988840e45c1" as EnvironmentId;
const threadId = "a8395a98-a186-4fe7-9d4c-fb8ba63b7588" as ThreadId;
const otherThreadId = "257598ad-ae4f-4422-a073-e03f4b4f5f0d" as ThreadId;

describe("threadNotificationTag", () => {
  it("returns a stable tag within the platform budget", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(threadNotificationTag(environmentId, threadId)).toBe(tag);
  });

  it("separates environments and threads", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(threadNotificationTag(otherEnvironmentId, threadId)).not.toBe(tag);
    expect(threadNotificationTag(environmentId, otherThreadId)).not.toBe(tag);
  });
});
