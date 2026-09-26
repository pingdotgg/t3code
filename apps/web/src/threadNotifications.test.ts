import { describe, expect, it } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";

/**
 * Production UUID pairs hash to 16 lowercase hex characters, under the Windows tag limit.
 */
function staysUnderWindowsRendererTagLimit() {
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const threadId = "22222222-2222-4222-8222-222222222222";
  expect(`${environmentId}:${threadId}`).toHaveLength(73);
  const tag = threadNotificationTag(environmentId, threadId);
  expect(tag).toMatch(/^[0-9a-f]{16}$/);
  expect(tag.length).toBeLessThanOrEqual(32);
  expect(tag).toBe("9467a46fece655ac");
  expect(tag).toBe(threadNotificationTag(environmentId, threadId));
}

/** Distinct environment or thread ids produce distinct compact tags. */
function keepsEnvironmentAndThreadUniqueness() {
  const sameThread = threadNotificationTag("env-1", "thread-1");
  expect(sameThread).not.toBe(threadNotificationTag("env-2", "thread-1"));
  expect(sameThread).not.toBe(threadNotificationTag("env-1", "thread-2"));
}

describe("threadNotificationTag", () => {
  it(
    "stays under the Windows renderer tag limit for production UUID pairs",
    staysUnderWindowsRendererTagLimit,
  );
  it("keeps environment and thread uniqueness", keepsEnvironmentAndThreadUniqueness);
});
